// netlify/functions/update-deals.mjs
// Runs daily at 8am ET — asks Claude directly for deals, no scraping

import https from 'https';

export const config = {
  schedule: "0 12 * * *",
};

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_OWNER  = process.env.GITHUB_OWNER;
const GITHUB_REPO   = process.env.GITHUB_REPO;

function apiRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on("error", reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error("Timeout")); });
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function getDeals() {
  const today = new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
  const prompt = `You are a deal curator for Scoop Deals (myscoopdeals.com). Today is ${today}.

Find the 12 best current deals and promo codes available right now from major retailers.

Return ONLY a JSON array of exactly 12 objects starting with [. No markdown.

Each object: { "brand":"", "domain":"brand.com", "badge":"Hot Deal", "badgeStyle":"badge-hot", "category":"Category · Sub", "title":"Deal title with savings", "description":"2-3 sentences", "discount":"40% OFF", "originalPrice":"Was $X or empty", "code":"CODE or empty", "noCode":"✓ No code or empty", "link":"https://url", "expiry":"⏰ date or empty" }

badgeStyle: badge-hot/badge-new/badge-email/badge-web/badge-free
Index 0 = best featured deal. Mix categories.`;

  const body = JSON.stringify({ model:"claude-sonnet-4-6", max_tokens:4000, messages:[{role:"user",content:prompt}] });
  const data = await apiRequest({
    hostname:"api.anthropic.com", path:"/v1/messages", method:"POST",
    headers:{ "Content-Type":"application/json", "Content-Length":Buffer.byteLength(body), "x-api-key":ANTHROPIC_KEY, "anthropic-version":"2023-06-01" }
  }, body);

  const text = data.content?.[0]?.text || "[]";
  const match = text.replace(/```json|```/g,"").trim().match(/\[.*\]/s);
  if (!match) throw new Error("No JSON in response");
  const deals = JSON.parse(match[0]);
  if (deals.length < 8) throw new Error(`Only ${deals.length} deals`);
  return deals;
}

function buildCard(d, i) {
  const f = i === 0;
  const logo = `<img src="https://logo.clearbit.com/${d.domain}" alt="${d.brand}" onerror="this.src='https://www.google.com/s2/favicons?sz=64&domain=${d.domain}';this.onerror=null;">`;
  const svg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8" height="9" rx="1"/><path d="M3 11V3a1 1 0 011-1h8"/></svg>`;
  const action = d.code ? `<div class="code-box" onclick="copyCode('${d.code}')">${svg}${d.code}</div>` : `<span class="no-code">${d.noCode||"✓ No code needed"}</span>`;
  const orig = d.originalPrice ? `<div class="deal-original">${d.originalPrice}</div>` : "";
  const exp = d.expiry ? `<div class="deal-exp">${d.expiry}</div>` : "";
  return `
  <div class="deal-card${f?" featured":""}">
    <div class="deal-card-img"${f?' style="width:220px;flex-shrink:0;"':""}}>${logo}<span class="deal-badge ${d.badgeStyle}">${d.badge}</span></div>
    <div class="deal-card-body">
      <div class="deal-source">${d.category}</div>
      <div class="deal-title"><a href="${d.link}" target="_blank">${d.title}</a></div>
      <div class="deal-desc">${d.description}</div>
      <div class="deal-footer"><div><div class="deal-discount">${d.discount}</div>${orig}</div>${action}</div>
      ${exp}
    </div>
  </div>`;
}

async function ghRequest(method, path, body) {
  const payload = body ? JSON.stringify(body) : undefined;
  return apiRequest({
    hostname:"api.github.com", path, method,
    headers:{ "Authorization":`token ${GITHUB_TOKEN}`, "User-Agent":"scoop-bot", "Accept":"application/vnd.github.v3+json", ...(payload ? {"Content-Type":"application/json","Content-Length":Buffer.byteLength(payload)} : {}) }
  }, payload);
}

export default async function handler() {
  try {
    console.log("Getting deals from Claude...");
    const deals = await getDeals();
    console.log(`Got ${deals.length} deals`);

    const file = await ghRequest("GET", `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/index.html`);
    let html = Buffer.from(file.content, "base64").toString("utf-8");

    const today = new Date().toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" });
    html = html.replace(/(<span class="badge">🔥 )([^<]+)(<\/span>)/, `$1${today}$3`);

    const cards = deals.map((d,i) => buildCard(d,i)).join("\n");
    const si = html.indexOf('<div class="deals-grid">');
    const ei = html.indexOf("</div><!-- end deals-grid -->");
    if (si === -1 || ei === -1) throw new Error("Grid markers not found");
    html = html.slice(0, si + 24) + "\n" + cards + "\n\n" + html.slice(ei);

    const date = new Date().toISOString().split("T")[0];
    const result = await ghRequest("PUT", `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/index.html`, {
      message: `🤖 Daily deals ${date}`,
      content: Buffer.from(html).toString("base64"),
      sha: file.sha
    });

    if (result.content) {
      console.log("✅ Done!");
      return new Response(JSON.stringify({ok:true, deals:deals.length}), {status:200});
    }
    throw new Error(JSON.stringify(result));
  } catch(e) {
    console.error("❌", e.message);
    return new Response(JSON.stringify({error:e.message}), {status:500});
  }
}
