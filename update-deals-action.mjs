// update-deals-action.mjs
// Daily deal updater — scrapes real sources, asks Claude, updates homepage
// SAFE: never writes empty grid, always validates before committing

import https from 'https';
import http from 'http';
import fs from 'fs';

const KEY = process.env.ANTHROPIC_API_KEY;

function fetchUrl(url) {
  return new Promise(resolve => {
    try {
      const lib = url.startsWith('http://') ? http : https;
      const req = lib.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ScoopDealsBot/1.0)' }
      }, res => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location)
          return fetchUrl(res.headers.location).then(resolve);
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
      });
      req.on('error', () => resolve(''));
      req.setTimeout(12000, () => { req.destroy(); resolve(''); });
    } catch { resolve(''); }
  });
}

function parseRSS(xml, n = 8) {
  const out = []; const rx = /<item[^>]*>([\s\S]*?)<\/item>/gi; let m;
  while ((m = rx.exec(xml)) && out.length < n) {
    const t = (m[1].match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
    const clean = s => s.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&#39;/g,"'").trim();
    const r = clean(t); if (r) out.push(r);
  }
  return out;
}

async function scrapeAll() {
  const results = [];
  const srcs = [
    { n:'r/deals',    url:'https://www.reddit.com/r/deals/top.json?limit=10&t=day',   reddit:true },
    { n:'r/coupons',  url:'https://www.reddit.com/r/coupons/top.json?limit=8&t=day',  reddit:true },
    { n:'r/freebies', url:'https://www.reddit.com/r/freebies/top.json?limit=8&t=day', reddit:true },
    { n:'r/frugal',   url:'https://www.reddit.com/r/frugal/top.json?limit=6&t=day',   reddit:true },
    { n:'Slickdeals', url:'https://slickdeals.net/newsearch.php?mode=frontpage&searcharea=deals&searchin=first&rss=1' },
    { n:'DealNews',   url:'https://www.dealnews.com/rated.rss' },
    { n:'Hip2Save',   url:'https://hip2save.com/feed/' },
    { n:"Brad's",     url:'https://bradsdeals.com/feed' },
    { n:'KCL',        url:'https://www.thekrazycouponlady.com/feed' },
  ];
  await Promise.allSettled(srcs.map(async s => {
    try {
      const raw = await fetchUrl(s.url); if (!raw) return;
      if (s.reddit) {
        const d = JSON.parse(raw);
        (d?.data?.children || []).slice(0,8).forEach(p => {
          if (p.data?.title && !p.data.over_18) results.push(`[${s.n}] ${p.data.title}`);
        });
      } else {
        parseRSS(raw, 8).forEach(t => results.push(`[${s.n}] ${t}`));
      }
    } catch(e) { console.warn(s.n, e.message); }
  }));
  return results;
}

async function getDeals(scraped) {
  const today = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const prompt = `You are a deal curator for Scoop Deals (myscoopdeals.com). Today is ${today}.

Real deals scraped today:
${scraped.slice(0,60).join('\n')}

Return ONLY a valid JSON array of exactly 12 deal objects. No markdown, no explanation, just the JSON array starting with [.
Each object must have: brand, domain, badge, badgeStyle, category, title, description, discount, originalPrice, code, noCode, link, expiry
badge: "Hot Deal" or "New" or "Verified" or "Freebie" or "Flash Sale"
badgeStyle: "badge-hot" or "badge-new" or "badge-email" or "badge-web" or "badge-free"
Index 0 = featured deal. Mix categories. All deals current for ${today}.`;

  const body = JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:4000, messages:[{ role:'user', content:prompt }] });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname:'api.anthropic.com', path:'/v1/messages', method:'POST',
      headers:{ 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body), 'x-api-key':KEY, 'anthropic-version':'2023-06-01' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const text = JSON.parse(d).content?.[0]?.text || '[]';
          const clean = text.replace(/```json|```/g,'').trim();
          const match = clean.match(/\[[\s\S]*\]/);
          if (!match) throw new Error('No JSON array found');
          const deals = JSON.parse(match[0]);
          if (!Array.isArray(deals) || deals.length === 0) throw new Error('Empty deals array');
          resolve(deals);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
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
  const exp  = d.expiry ? `<div class="deal-exp">${d.expiry}</div>` : '';
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
  console.log('Scraping sources...');
  const scraped = await scrapeAll();
  console.log(`Got ${scraped.length} raw items`);

  console.log('Asking Claude...');
  const deals = await getDeals(scraped);
  console.log(`Got ${deals.length} deals`);

  // SAFETY CHECK: never write fewer than 8 deals
  if (deals.length < 8) {
    throw new Error(`Only ${deals.length} deals returned — not enough, aborting to protect site`);
  }

  const html = fs.readFileSync('index.html', 'utf8');

  const today = new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
  let updated = html.replace(/(<span class="badge">🔥 )([^<]+)(<\/span>)/, `$1${today}$3`);

  // Build and inject cards
  const cards = deals.map((d,i) => buildCard(d,i)).join('\n');

  const START = '<div class="deals-grid">';
  const END   = '</div><!-- end deals-grid -->';
  const si = updated.indexOf(START);
  const ei = updated.indexOf(END);

  if (si === -1 || ei === -1) throw new Error('Could not find deals-grid markers in HTML');

  updated = updated.slice(0, si + START.length) + '\n' + cards + '\n\n' + updated.slice(ei);

  // SAFETY CHECK: verify we actually wrote cards
  const cardCount = (updated.match(/class="deal-card/g) || []).length;
  if (cardCount < 8) {
    throw new Error(`Only ${cardCount} cards in output — aborting to protect site`);
  }

  fs.writeFileSync('index.html', updated);
  console.log(`Done! ${deals.length} deals updated for ${today}`);
}

main().catch(e => {
  console.error('FAILED:', e.message);
  // Exit with error so GitHub Actions marks the run as failed
  // but does NOT commit the broken file
  process.exit(1);
});
