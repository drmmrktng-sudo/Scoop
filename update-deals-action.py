#!/usr/bin/env python3
"""
Daily deal updater for Scoop Deals
Asks Claude for today's best deals and updates index.html
"""
import os, json, re, urllib.request, urllib.error
from datetime import datetime

ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]
GITHUB_TOKEN  = os.environ["GITHUB_TOKEN"]
GITHUB_OWNER  = os.environ.get("GITHUB_REPOSITORY","").split("/")[0]
GITHUB_REPO   = os.environ.get("GITHUB_REPOSITORY","").split("/")[-1]

def call_claude(prompt):
    body = json.dumps({
        "model": "claude-sonnet-4-6",
        "max_tokens": 4000,
        "messages": [{"role": "user", "content": prompt}]
    }).encode()
    
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01"
        },
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def get_deals():
    today = datetime.now().strftime("%A, %B %-d, %Y")
    prompt = f"""You are a deal curator for Scoop Deals. Today is {today}.

Find the 12 best current deals, promo codes and sales available right now from major retailers like Amazon, Target, Walmart, Best Buy, Nike, Ulta, Chewy, Kohl's, Nordstrom, Wayfair, Home Depot, Lowe's, Sephora, Bath & Body Works, Gap, Old Navy, Lululemon, REI, Dick's, CVS, Walgreens and others.

Return ONLY a JSON array of exactly 12 objects. Start with [ immediately. No markdown fences.

Each object needs these exact fields:
brand, domain, badge, badgeStyle, category, title, description, discount, originalPrice, code, noCode, link, expiry

badge: Hot Deal / New / Verified / Freebie / Flash Sale / Email Exclusive
badgeStyle: badge-hot / badge-new / badge-email / badge-web / badge-free

Index 0 = best featured deal. Mix: fashion, home, food, tech, pets, beauty, grocery, kids."""

    response = call_claude(prompt)
    text = response["content"][0]["text"]
    
    # Extract JSON array
    text = text.replace("```json","").replace("```","").strip()
    match = re.search(r'\[.*\]', text, re.DOTALL)
    if not match:
        raise ValueError(f"No JSON array found. Response: {text[:300]}")
    
    deals = json.loads(match.group(0))
    if len(deals) < 8:
        raise ValueError(f"Only {len(deals)} deals returned")
    return deals

def build_card(d, i):
    featured = i == 0
    logo = f'<img src="https://logo.clearbit.com/{d["domain"]}" alt="{d["brand"]}" onerror="this.src='https://www.google.com/s2/favicons?sz=64&domain={d["domain"]}';this.onerror=null;">'
    
    if d.get("code"):
        action = f'<div class="code-box" onclick="copyCode(\'{d["code"]}\'")><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8" height="9" rx="1"/><path d="M3 11V3a1 1 0 011-1h8"/></svg>{d["code"]}</div>'
    else:
        action = f'<span class="no-code">{d.get("noCode", "✓ No code needed")}</span>'
    
    orig = f'<div class="deal-original">{d["originalPrice"]}</div>' if d.get("originalPrice") else ""
    exp  = f'<div class="deal-exp">{d["expiry"]}</div>' if d.get("expiry") else ""
    
    featured_class = " featured" if featured else ""
    img_style = ' style="width:220px;flex-shrink:0;"' if featured else ""
    
    return f"""
  <div class="deal-card{featured_class}">
    <div class="deal-card-img"{img_style}>{logo}<span class="deal-badge {d["badgeStyle"]}">{d["badge"]}</span></div>
    <div class="deal-card-body">
      <div class="deal-source">{d["category"]}</div>
      <div class="deal-title"><a href="{d["link"]}" target="_blank">{d["title"]}</a></div>
      <div class="deal-desc">{d["description"]}</div>
      <div class="deal-footer"><div><div class="deal-discount">{d["discount"]}</div>{orig}</div>{action}</div>
      {exp}
    </div>
  </div>"""

def main():
    print("Asking Claude for today's deals...")
    deals = get_deals()
    print(f"Got {len(deals)} deals")
    
    with open("index.html", "r") as f:
        html = f.read()
    
    today = datetime.now().strftime("%B %-d, %Y")
    html = re.sub(r'(<span class="badge">🔥 )([^<]+)(</span>)', f'\\g<1>{today}\\g<3>', html)
    
    cards = "\n".join(build_card(d, i) for i, d in enumerate(deals))
    
    start = html.find('<div class="deals-grid">')
    end = html.find('</div><!-- end deals-grid -->')
    if start == -1 or end == -1:
        raise ValueError("deals-grid markers not found")
    
    html = html[:start + len('<div class="deals-grid">')] + "\n" + cards + "\n\n" + html[end:]
    
    count = html.count('class="deal-card')
    if count < 8:
        raise ValueError(f"Only {count} cards written")
    
    with open("index.html", "w") as f:
        f.write(html)
    
    print(f"Done! {len(deals)} deals for {today}")

if __name__ == "__main__":
    main()
