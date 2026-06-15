// update-deals-action.mjs
// Daily deal updater — asks Claude for today's best deals
// No external scraping needed — Claude knows current deals

import https from 'https';
import fs from 'fs';

const KEY = process.env.ANTHROPIC_API_KEY;

async function getDeals() {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const prompt = `You are a deal curator for Scoop Deals (myscoopdeals.com). Today is ${today}.

Find the 12 best current deals, promo codes and sales available right now from stores like Amazon, Target, Walmart, Best Buy, Nike, Ulta, Chewy, Kohl's, Nordstrom, Wayfair, Home Depot, Lowe's, Sephora, Bath & Body Works, Old Navy, Gap, Lululemon, REI, Dick's Sporting Goods, CVS, Walgreens and other major retailers.

Return ONLY a valid JSON array of exactly 12 objects. No markdown, no explanation. Start directly with [

Each object must have exactly these fields:
{
  "brand": "Brand Name",
  "domain": "brand.com",
  "badge": "Hot Deal",
  "badgeStyle": "badge-hot",
  "category": "Category · Subcategory",
  "title": "Specific deal title with actual price or % savings",
  "description": "2-3 sentences explaining the deal, how to get it, any restrictions",
  "discount": "40% OFF",
  "originalPrice": "Was $X or empty string",
  "code": "PROMOCODE or empty string",
  "noCode": "✓ No code needed or empty string if code exists",
  "link": "https://direct-url-to-deal",
  "expiry": "⏰ Expires [date] or ⚡ Today only or empty string"
}

badge options: Hot Deal, New, Verified, Freebie, Flash Sale, Email Exclusive
badgeStyle options: badge-hot, badge-new, badge-email, badge-web, badge-free

Rules:
- Index 0 must be the BEST deal (becomes the wide featured card)
- Include a mix: fashion, home, food, tech, pets, beauty, grocery, kids
- Use real current deals you know about for ${today}
- Prioritize deals with actual promo codes`;

  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01'
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) throw new Error(parsed.error.message);
          const text = parsed.content?.[0]?.text || '';
          console.log('Claude response length:', text.length);
          const match = text.replace(/```json|```/g, '').trim().match(/\[[\s\S]*\]/);
          if (!match) throw new Error('No JSON array in response. Response: ' + text.slice(0, 200));
          const deals = JSON.parse(match[0]);
          if (!Array.isArray(deals) || deals.length < 8) throw new Error(`Only ${deals.length} deals returned`);
          resolve(deals);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('API timeout')); });
    req.write(body);
    req.end();
  });
}

function buildCard(d, i) {
  const f = i === 0;
  const logo = `<img src="https://logo.clearbit.com/${d.domain}" alt="${d.brand}" onerror="this.src='https://www.google.com/s2/favicons?sz=64&domain=${d.domain}';this.onerror=null;">`;
  const code = d.code
    ? `<div class="code-box" onclick="copyCode('${d.code}')"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8" height="9" rx="1"/><path d="M3 11V3a1 1 0 011-1h8"/></svg>${d.code}</div>`
    : `<span class="no-code">${d.noCode || '✓ No code needed'}</span>`;
  const orig = d.originalPrice ? `<div class="deal-original">${d.originalPrice}</div>` : '';
  const exp = d.expiry ? `<div class="deal-exp">${d.expiry}</div>` : '';
  return `
  <div class="deal-card${f ? ' featured' : ''}">
    <div class="deal-card-img"${f ? ' style="width:220px;flex-shrink:0;"' : ''}>${logo}<span class="deal-badge ${d.badgeStyle}">${d.badge}</span></div>
    <div class="deal-card-body">
      <div class="deal-source">${d.category}</div>
      <div class="deal-title"><a href="${d.link}" target="_blank">${d.title}</a></div>
      <div class="deal-desc">${d.description}</div>
      <div class="deal-footer"><div><div class="deal-discount">${d.discount}</div>${orig}</div>${code}</div>
      ${exp}
    </div>
  </div>`;
}

async function main() {
  if (!KEY) throw new Error('ANTHROPIC_API_KEY not set');
  console.log('Asking Claude for today\'s deals...');

  const deals = await getDeals();
  console.log(`Got ${deals.length} deals`);

  let html = fs.readFileSync('index.html', 'utf8');

  // Update date
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  html = html.replace(/(<span class="badge">🔥 )([^<]+)(<\/span>)/, `$1${today}$3`);

  // Replace deals grid
  const START = '<div class="deals-grid">';
  const END = '</div><!-- end deals-grid -->';
  const si = html.indexOf(START);
  const ei = html.indexOf(END);
  if (si === -1 || ei === -1) throw new Error('deals-grid markers not found');

  const cards = deals.map((d, i) => buildCard(d, i)).join('\n');
  html = html.slice(0, si + START.length) + '\n' + cards + '\n\n' + html.slice(ei);

  // Verify
  const count = (html.match(/class="deal-card/g) || []).length;
  if (count < 8) throw new Error(`Only ${count} cards written — aborting`);

  fs.writeFileSync('index.html', html);
  console.log(`✅ Done! ${deals.length} deals for ${today}`);
}

main().catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
