// netlify/functions/update-deals.mjs
// Runs daily at 8am ET — zero npm dependencies, uses native Node https only

import https from "https";

export const config = {
  schedule: "0 12 * * *", // 8am ET (12:00 UTC)
};

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_OWNER  = process.env.GITHUB_OWNER;
const GITHUB_REPO   = process.env.GITHUB_REPO;

// ── Generic HTTPS request helper ──────────────────────────────────────────────
function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

// ── 1. Ask Claude for today's deals ──────────────────────────────────────────
async function fetchDealsFromClaude() {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const prompt = `You are a deal curator for Scoop Deals. Today is ${today}.

Find the best current deals and promo codes across major retailers.

Return ONLY a valid JSON array of exactly 12 deal objects, no markdown, no explanation.
Each object must have exactly these fields:
{
  "brand": "Brand Name",
  "domain": "brand.com",
  "badge": "Hot Deal or New or Email Exclusive or Verified or Freebie or Flash Sale",
  "badgeStyle": "badge-hot or badge-new or badge-email or badge-web or badge-free",
  "category": "Category · Subcategory",
  "title": "Specific deal title",
  "description": "2-3 sentences with key deal details",
  "discount": "40% OFF or $12.99 or B1G1",
  "originalPrice": "Was $X or empty string",
  "code": "PROMOCODE or empty string",
  "noCode": "✓ No code needed or empty string if code exists",
  "link": "https://full-url-to-deal-page",
  "expiry": "⏰ Expires [date] or ⚡ Today only or empty string"
}

Include a mix of: fashion, home, food, tech, pets, beauty, grocery, kids.
First item (index 0) is the featured deal — make it the best one.
All deals must be realistic and current for ${today}.`;

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
  return JSON.parse(clean);
}

// ── 2. Build HTML for a deal card ─────────────────────────────────────────────
function buildCard(deal, index) {
  const featured = index === 0;
  const logo = `<img src="https://logo.clearbit.com/${deal.domain}" alt="${deal.brand}" onerror="this.src='https://www.google.com/s2/favicons?sz=64&domain=${deal.domain}';this.onerror=null;">`;
  const codeHtml = deal.code
    ? `<div class="code-box" onclick="copyCode('${deal.code}')"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8" height="9" rx="1"/><path d="M3 11V3a1 1 0 011-1h8"/></svg>${deal.code}</div>`
    : `<span class="no-code">${deal.noCode}</span>`;
  const expHtml = deal.expiry ? `<div class="deal-exp">${deal.expiry}</div>` : "";
  const titleHtml = `<div class="deal-title"><a href="${deal.link}" target="_blank">${deal.title}</a></div>`;

  if (featured) {
    return `
  <div class="deal-card featured">
    <div class="deal-card-img">${logo}<span class="deal-badge ${deal.badgeStyle}">${deal.badge}</span></div>
    <div class="deal-card-body">
      <div class="deal-source">${deal.category}</div>
      ${titleHtml}
      <div class="deal-desc">${deal.description}</div>
      <div class="deal-footer">
        <div><div class="deal-discount">${deal.discount}</div>${deal.originalPrice ? `<div class="deal-original">${deal.originalPrice}</div>` : ""}</div>
        ${codeHtml}
      </div>${expHtml}
    </div>
  </div>`;
  }

  return `
  <div class="deal-card">
    <div class="deal-card-img">${logo}<span class="deal-badge ${deal.badgeStyle}">${deal.badge}</span></div>
    <div class="deal-card-body">
      <div class="deal-source">${deal.category}</div>
      ${titleHtml}
      <div class="deal-desc">${deal.description}</div>
      <div class="deal-footer">
        <div><div class="deal-discount">${deal.discount}</div>${deal.originalPrice ? `<div class="deal-original">${deal.originalPrice}</div>` : ""}</div>
        ${codeHtml}
      </div>${expHtml}
    </div>
  </div>`;
}

// ── 3. Get file from GitHub ───────────────────────────────────────────────────
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

// ── 4. Push file to GitHub ────────────────────────────────────────────────────
async function pushFile(path, content, sha, message) {
  const body = JSON.stringify({
    message,
    content: Buffer.from(content).toString("base64"),
    sha,
  });
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

// ── 5. Main handler ───────────────────────────────────────────────────────────
export default async function handler() {
  try {
    console.log("🔄 Starting daily deal update...");

    // Get current index.html
    const { content: html, sha } = await getFile("index.html");

    // Fetch fresh deals from Claude
    console.log("🤖 Asking Claude for today's deals...");
    const deals = await fetchDealsFromClaude();
    console.log(`✅ Got ${deals.length} deals`);

    // Build new cards HTML
    const cardsHtml = deals.map((d, i) => buildCard(d, i)).join("\n");

    // Update date badge
    const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    let updated = html.replace(
      /(<span class="badge">🔥 )([^<]+)(<\/span>)/,
      `$1${today}$3`
    );

    // Replace deals grid content
    updated = updated.replace(
      /(<div class="deals-grid">)([\s\S]*?)(<\/div><!-- end deals-grid -->)/,
      `$1\n${cardsHtml}\n\n$3`
    );

    // Push back to GitHub
    const date = new Date().toISOString().split("T")[0];
    const result = await pushFile("index.html", updated, sha, `🤖 Daily deal update — ${date}`);

    if (result.content) {
      console.log("✅ Deals updated successfully!");
      return new Response("OK", { status: 200 });
    } else {
      throw new Error(JSON.stringify(result));
    }

  } catch (err) {
    console.error("❌ Update failed:", err.message);
    return new Response("Error: " + err.message, { status: 500 });
  }
}
