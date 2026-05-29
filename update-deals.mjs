// netlify/functions/update-deals.mjs
// Runs daily at 8am ET — calls Claude to generate fresh deals,
// then writes them into deals-site.html via a GitHub commit.

import { Octokit } from "@octokit/rest";

export const config = {
  schedule: "0 12 * * *", // 8am ET (12:00 UTC)
};

const CLAUDE_API = "https://api.anthropic.com/v1/messages";
const GITHUB_REPO_OWNER = process.env.GITHUB_OWNER;   // your GitHub username
const GITHUB_REPO_NAME  = process.env.GITHUB_REPO;    // e.g. "scoop-deals"
const GITHUB_TOKEN      = process.env.GITHUB_TOKEN;
const ANTHROPIC_KEY     = process.env.ANTHROPIC_API_KEY;

// ── 1. Ask Claude for today's deals ──────────────────────────────────────────
async function fetchDealsFromClaude() {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const prompt = `You are a deal curator for a website called Scoop. Today is ${today}.

Search your knowledge for the best current deals, promo codes, and sales from sources like:
Slickdeals, Hip2Save, Brad's Deals, Krazy Coupon Lady, DealNews, and major brand email newsletters.

Return ONLY a JSON array (no markdown, no explanation) of exactly 12 deal objects.
Each object must have these exact fields:
{
  "brand": "Brand Name",
  "domain": "brand.com",
  "badge": "one of: Hot, New, Email, Brad's Exclusive, KCL, Hip2Save, Slickdeals, Freebie",
  "badgeStyle": "one of: badge-hot, badge-new, badge-email, badge-web, badge-free",
  "source": "Source name · timeframe",
  "category": "Category · Subcategory",
  "title": "Deal title (concise, specific)",
  "description": "2-3 sentence description of the deal with key details",
  "discount": "e.g. 40% OFF or $12.99 or B1G1",
  "originalPrice": "original price or empty string",
  "code": "PROMOCODE or empty string if no code needed",
  "noCode": "Short note like ✓ No code needed or empty string if code exists",
  "expiry": "⏰ Expires [date] or ⚡ Today only or empty string"
}

Make all deals realistic, specific, and current for today. Include a mix of categories:
fashion, home, food, tech, pets, beauty, grocery, kids. Featured deal should be index 0.`;

  const res = await fetch(CLAUDE_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await res.json();
  const text = data.content?.[0]?.text ?? "[]";

  // Strip any accidental markdown fences
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ── 2. Build deal card HTML from a deal object ────────────────────────────────
function buildDealCard(deal, index) {
  const featured = index === 0;
  const logoImg = `<img src="https://logo.clearbit.com/${deal.domain}" alt="${deal.brand}"
    onerror="this.style.display='none'">`;

  const codeHTML = deal.code
    ? `<div class="code-box" onclick="copyCode('${deal.code}')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="5" y="5" width="8" height="9" rx="1"/>
          <path d="M3 11V3a1 1 0 011-1h8"/>
        </svg>${deal.code}
      </div>`
    : `<span class="no-code">${deal.noCode}</span>`;

  const expiryHTML = deal.expiry
    ? `<div class="deal-exp">${deal.expiry}</div>` : "";

  if (featured) {
    return `
  <div class="deal-card featured">
    <div class="deal-card-img">
      ${logoImg}
      <span class="deal-badge ${deal.badgeStyle}">${deal.badge}</span>
    </div>
    <div class="deal-card-body">
      <div class="src-tag">${deal.source}</div>
      <div class="deal-source">${deal.category}</div>
      <div class="deal-title">${deal.title}</div>
      <div class="deal-desc">${deal.description}</div>
      <div class="deal-footer">
        <div>
          <div class="deal-discount">${deal.discount}</div>
          ${deal.originalPrice ? `<div class="deal-original">${deal.originalPrice}</div>` : ""}
        </div>
        ${codeHTML}
      </div>
      ${expiryHTML}
    </div>
  </div>`;
  }

  return `
  <div class="deal-card">
    <div class="deal-card-img">
      ${logoImg}
      <span class="deal-badge ${deal.badgeStyle}">${deal.badge}</span>
    </div>
    <div class="deal-card-body">
      <div class="src-tag">${deal.source}</div>
      <div class="deal-source">${deal.category}</div>
      <div class="deal-title">${deal.title}</div>
      <div class="deal-desc">${deal.description}</div>
      <div class="deal-footer">
        <div>
          <div class="deal-discount">${deal.discount}</div>
          ${deal.originalPrice ? `<div class="deal-original">${deal.originalPrice}</div>` : ""}
        </div>
        ${codeHTML}
      </div>
      ${expiryHTML}
    </div>
  </div>`;
}

// ── 3. Inject new deals into the HTML file ───────────────────────────────────
function injectDeals(html, deals) {
  const today = new Date().toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });

  // Update the date badge
  html = html.replace(
    /(<span class="badge">🔥 )([^<]+)(<\/span>)/,
    `$1${today}$3`
  );

  // Replace everything between the deals-grid div tags
  const cardsHTML = deals.map((d, i) => buildDealCard(d, i)).join("\n");
  html = html.replace(
    /(<div class="deals-grid">)([\s\S]*?)(<\/div><!-- end deals-grid -->)/,
    `$1\n${cardsHTML}\n\n$3`
  );

  return html;
}

// ── 4. Read & write the HTML file via GitHub API ─────────────────────────────
export default async function handler() {
  try {
    console.log("🔄 Starting daily deal update...");

    const octokit = new Octokit({ auth: GITHUB_TOKEN });

    // Get current file content + SHA (needed for update)
    const { data: fileData } = await octokit.repos.getContent({
      owner: GITHUB_REPO_OWNER,
      repo:  GITHUB_REPO_NAME,
      path:  "deals-site.html",
    });

    const currentHTML = Buffer.from(fileData.content, "base64").toString("utf-8");

    // Fetch fresh deals from Claude
    console.log("🤖 Asking Claude for today's deals...");
    const deals = await fetchDealsFromClaude();
    console.log(`✅ Got ${deals.length} deals from Claude`);

    // Inject into HTML
    const updatedHTML = injectDeals(currentHTML, deals);

    // Commit back to GitHub
    const today = new Date().toISOString().split("T")[0];
    await octokit.repos.createOrUpdateFileContents({
      owner:   GITHUB_REPO_OWNER,
      repo:    GITHUB_REPO_NAME,
      path:    "deals-site.html",
      message: `🤖 Daily deal update — ${today}`,
      content: Buffer.from(updatedHTML).toString("base64"),
      sha:     fileData.sha,
    });

    console.log("✅ Deals updated and committed to GitHub!");
    return new Response("OK", { status: 200 });

  } catch (err) {
    console.error("❌ Update failed:", err);
    return new Response("Error: " + err.message, { status: 500 });
  }
}
