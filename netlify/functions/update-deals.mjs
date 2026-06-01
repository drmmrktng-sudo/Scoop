// netlify/functions/update-deals.mjs
// Runs daily at 8am ET
// Scrapes Reddit, Slickdeals, Hip2Save, Brad's Deals, KCL, DealNews RSS feeds
// then asks Claude to curate the best deals and pushes to GitHub

import https from "https";
import http from "http";

export const config = {
  schedule: "0 12 * * *", // 8am ET (12:00 UTC)
};

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_OWNER  = process.env.GITHUB_OWNER;
const GITHUB_REPO   = process.env.GITHUB_REPO;

// ── Generic request helper ────────────────────────────────────────────────────
function request(urlOrOptions, body, isHttp = false) {
  return new Promise((resolve, reject) => {
    const lib = isHttp ? http : https;
    const req = lib.request(urlOrOptions, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(request(res.headers.location, body));
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

// ── Fetch a URL and return text ───────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve) => {
    try {
      const lib = url.startsWith("http://") ? http : https;
      const req = lib.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ScoopDealsBot/1.0)",
          "Accept": "application/rss+xml, application/xml, text/xml, application/json, */*",
        }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchUrl(res.headers.location).then(resolve).catch(() => resolve(""));
        }
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      });
      req.on("error", () => resolve(""));
      req.setTimeout(10000, () => { req.destroy(); resolve(""); });
    } catch { resolve(""); }
  });
}

// ── Parse RSS feed — extract titles and links ─────────────────────────────────
function parseRSS(xml, limit = 8) {
  const items = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
    const block = match[1];
    const title = (block.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                   block.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || "";
    const link  = (block.match(/<link[^>]*>([\s\S]*?)<\/link>/) ||
                   block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1] || "";
    const desc  = (block.match(/<description[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
                   block.match(/<description[^>]*>([\s\S]*?)<\/description>/) || [])[1] || "";
    const cleanTitle = title.replace(/<[^>]+>/g, "").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#39;/g,"'").replace(/&quot;/g,'"').trim();
    const cleanDesc  = desc.replace(/<[^>]+>/g, "").replace(/&amp;/g,"&").trim().slice(0, 200);
    if (cleanTitle) items.push({ title: cleanTitle, link: link.trim(), desc: cleanDesc });
  }
  return items;
}

// ── Scrape all deal sources ───────────────────────────────────────────────────
async function scrapeAllSources() {
  const sources = [
    // Reddit public JSON API — no auth needed
    { name: "Reddit r/deals",    url: "https://www.reddit.com/r/deals/top.json?limit=10&t=day" },
    { name: "Reddit r/coupons",  url: "https://www.reddit.com/r/coupons/top.json?limit=8&t=day" },
    { name: "Reddit r/freebies", url: "https://www.reddit.com/r/freebies/top.json?limit=8&t=day" },
    { name: "Reddit r/frugal",   url: "https://www.reddit.com/r/frugal/top.json?limit=6&t=day" },
    // RSS feeds
    { name: "Slickdeals",        url: "https://slickdeals.net/newsearch.php?mode=frontpage&searcharea=deals&searchin=first&rss=1", rss: true },
    { name: "DealNews",          url: "https://www.dealnews.com/rated.rss", rss: true },
    { name: "Hip2Save",          url: "https://hip2save.com/feed/", rss: true },
    { name: "Brad's Deals",      url: "https://bradsdeals.com/feed", rss: true },
    { name: "Krazy Coupon Lady", url: "https://www.thekrazycouponlady.com/feed", rss: true },
    { name: "RetailMeNot",       url: "https://www.retailmenot.com/blog/feed/", rss: true },
  ];

  const results = [];

  await Promise.allSettled(sources.map(async (src) => {
    try {
      const raw = await fetchUrl(src.url);
      if (!raw) return;

      if (src.rss) {
        // Parse RSS
        const items = parseRSS(raw, 8);
        items.forEach(item => {
          results.push(`[${src.name}] ${item.title}${item.desc ? " — " + item.desc : ""}`);
        });
      } else {
        // Parse Reddit JSON
        let data;
        try { data = JSON.parse(raw); } catch { return; }
        const posts = data?.data?.children || [];
        posts.slice(0, 8).forEach(post => {
          const p = post.data;
          if (p && p.title && !p.over_18) {
            results.push(`[${src.name}] ${p.title}${p.selftext ? " — " + p.selftext.slice(0, 150) : ""}`);
          }
        });
      }
    } catch (e) {
      console.log(`⚠️ ${src.name} failed: ${e.message}`);
    }
  }));

  return results;
}

// ── Ask Claude to curate deals from scraped content ───────────────────────────
async function fetchDealsFromClaude(scrapedDeals) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const dealsList = scrapedDeals.length > 0
    ? scrapedDeals.slice(0, 60).join("\n")
    : "No scraped data available — use your knowledge of current deals.";

  const prompt = `You are a deal curator for Scoop Deals (myscoopdeals.com). Today is ${today}.

Here are real deals scraped from Reddit, Slickdeals, Hip2Save, Brad's Deals, Krazy Coupon Lady, and DealNews today:

${dealsList}

Based on these real scraped deals PLUS your knowledge of current sales and promo codes, curate the 12 BEST deals for today.

Return ONLY a valid JSON array of exactly 12 deal objects. No markdown, no explanation, just the JSON array.
Each object must have exactly these fields:
{
  "brand": "Brand Name",
  "domain": "brand.com",
  "badge": "Hot Deal or New or Verified or Flash Sale or Freebie or Email Exclusive",
  "badgeStyle": "badge-hot or badge-new or badge-email or badge-web or badge-free",
  "category": "Category · Subcategory",
  "title": "Specific deal title with price or % off",
  "description": "2-3 sentences with key deal details, how to redeem, and any stacking tips",
  "discount": "40% OFF or $12.99 or B1G1 or FREE",
  "originalPrice": "Was $X or empty string",
  "code": "PROMOCODE or empty string if no code needed",
  "noCode": "✓ No code needed or empty string if code exists",
  "link": "https://direct-url-to-deal",
  "expiry": "⏰ Expires [date] or ⚡ Today only or ⚡ Limited time or empty string"
}

Rules:
- Index 0 must be the BEST featured deal (most savings or most popular)
- Mix categories: fashion, home, food, tech, pets, beauty, grocery, kids, freebies
- All deals must be real and current for ${today}
- Include specific prices, codes, and direct links where possible
- Prioritize deals with verified promo codes`;

  const body = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  const data = await request({
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
  }, body);

  const text = data.content?.[0]?.text ?? "[]";
  const clean = text.replace(/```json|```/g, "").trim();

  // Find JSON array in response
  const match = clean.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("No JSON array found in Claude response");
  return JSON.parse(match[0]);
}

// ── Build deal card HTML ──────────────────────────────────────────────────────
function buildCard(deal, index) {
  const featured = index === 0;
  const logo = `<img src="https://logo.clearbit.com/${deal.domain}" alt="${deal.brand}" onerror="this.src='https://www.google.com/s2/favicons?sz=64&domain=${deal.domain}';this.onerror=null;">`;
  const codeHtml = deal.code
    ? `<div class="code-box" onclick="copyCode('${deal.code}')"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8" height="9" rx="1"/><path d="M3 11V3a1 1 0 011-1h8"/></svg>${deal.code}</div>`
    : `<span class="no-code">${deal.noCode}</span>`;
  const expHtml = deal.expiry ? `<div class="deal-exp">${deal.expiry}</div>` : "";

  const cardClass = featured ? "deal-card featured" : "deal-card";
  const imgStyle = featured ? ' style="width:220px;flex-shrink:0;"' : '';

  return `
  <div class="${cardClass}">
    <div class="deal-card-img"${imgStyle}>${logo}<span class="deal-badge ${deal.badgeStyle}">${deal.badge}</span></div>
    <div class="deal-card-body">
      <div class="deal-source">${deal.category}</div>
      <div class="deal-title"><a href="${deal.link}" target="_blank">${deal.title}</a></div>
      <div class="deal-desc">${deal.description}</div>
      <div class="deal-footer">
        <div>
          <div class="deal-discount">${deal.discount}</div>
          ${deal.originalPrice ? `<div class="deal-original">${deal.originalPrice}</div>` : ""}
        </div>
        ${codeHtml}
      </div>
      ${expHtml}
    </div>
  </div>`;
}

// ── GitHub helpers ────────────────────────────────────────────────────────────
async function getFile(path) {
  const data = await request({
    hostname: "api.github.com",
    path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`,
    method: "GET",
    headers: {
      "Authorization": `token ${GITHUB_TOKEN}`,
      "User-Agent": "scoop-deals-bot",
      "Accept": "application/vnd.github.v3+json",
    },
  });
  return {
    content: Buffer.from(data.content, "base64").toString("utf-8"),
    sha: data.sha,
  };
}

async function pushFile(path, content, sha, message) {
  const body = JSON.stringify({ message, content: Buffer.from(content).toString("base64"), sha });
  return request({
    hostname: "api.github.com",
    path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`,
    method: "PUT",
    headers: {
      "Authorization": `token ${GITHUB_TOKEN}`,
      "User-Agent": "scoop-deals-bot",
      "Accept": "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler() {
  try {
    console.log("🔄 Starting daily deal update...");

    // Step 1: Scrape all sources in parallel
    console.log("🕷️ Scraping Reddit, Slickdeals, Hip2Save, Brad's Deals, KCL, DealNews...");
    const scrapedDeals = await scrapeAllSources();
    console.log(`📦 Scraped ${scrapedDeals.length} raw deals from all sources`);

    // Step 2: Ask Claude to curate the best deals
    console.log("🤖 Asking Claude to curate today's best deals...");
    const deals = await fetchDealsFromClaude(scrapedDeals);
    console.log(`✅ Got ${deals.length} curated deals`);

    // Step 3: Build HTML cards
    const cardsHtml = deals.map((d, i) => buildCard(d, i)).join("\n");

    // Step 4: Get current index.html
    const { content: html, sha } = await getFile("index.html");

    // Step 5: Update date badge
    const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    let updated = html.replace(
      /(<span class="badge">🔥 )([^<]+)(<\/span>)/,
      `$1${today}$3`
    );

    // Step 6: Replace entire deals grid content
    updated = updated.replace(
      /(<div class="deals-grid">)([\s\S]*?)(<\/div><!-- end deals-grid -->)/,
      `$1\n${cardsHtml}\n\n$3`
    );

    // Step 7: Push to GitHub → Netlify auto-deploys
    const date = new Date().toISOString().split("T")[0];
    const result = await pushFile(
      "index.html",
      updated,
      sha,
      `🤖 Daily deal update — ${date} (scraped ${scrapedDeals.length} sources)`
    );

    if (result.content) {
      console.log(`✅ Successfully updated ${deals.length} deals from ${scrapedDeals.length} scraped items!`);
      return new Response(JSON.stringify({ success: true, deals: deals.length, scraped: scrapedDeals.length }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } else {
      throw new Error(JSON.stringify(result));
    }

  } catch (err) {
    console.error("❌ Update failed:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
