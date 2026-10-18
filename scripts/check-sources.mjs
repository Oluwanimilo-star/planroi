#!/usr/bin/env node
// PlanROI source checker.
// Fetches every pricing source referenced by src/data/plans.json, extracts *structured facts*
// (prices, multipliers, credit/message/context numbers, plan-tied limit/reset statements),
// and compares them as a sorted set against data/snapshots/<source>.json.
// Wording changes, nav/footer/sidebar churn and pure reordering produce no change.
// Fetch errors are reported as warnings and never count as changes.
//
// Usage: node scripts/check-sources.mjs [--update] [--playwright] [--dry]
//   --update      write changed/new fact snapshots
//   --playwright  allow Playwright for sources configured with mode "playwright"
//   --dry         never write snapshots (even new ones)
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SNAP = path.join(root, 'data/snapshots');
const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const DRY = args.includes('--dry');
const USE_PW = args.includes('--playwright') || process.env.USE_PLAYWRIGHT === '1';
const PRINT = args.includes('--facts'); // debug: print extracted facts per source
const FORCE_MODE = process.env.CHECK_FORCE_MODE; // debug: override every source's mode (fetch|playwright)
const plansDoc = JSON.parse(await fs.readFile(path.join(root, 'src/data/plans.json'), 'utf8'));
const plans = plansDoc.plans;

// Per-source settings. Sources not listed use plain fetch.
const SOURCES = {
  'https://chatgpt.com/pricing': {
    // The page HTML (context windows, limits) loads in a real browser, but the prices are filled in
    // client-side from a bot-protected pricing endpoint that answers 403 after a few automated requests,
    // and the whole page answers 403 to GitHub Actions runners. So prices on this page are never part of
    // the compared facts; they are verified against the official fallback pages below instead.
    mode: 'playwright',
    waitFor: () => [...document.querySelectorAll('span.tabular-nums')].some(s => /\d/.test(s.textContent)),
    waitOptional: true,
    volatilePrices: true,
    knownBlocked: 'page answers HTTP 403 to GitHub Actions runners; prices load from a bot-protected endpoint',
    // Official pages that state the same plan prices (verified 2026-10-18):
    // Codex pricing lists Free $0 / Go $8 / Plus $20 / Pro $100-$200-$500; the Pro tiers help article lists $100/$200/$500.
    fallback: ['https://developers.openai.com/codex/pricing', 'https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers'],
  },
  // Plan cards are rendered client-side (plain HTML only has skeletons + the comparison table).
  // The cards run an A/B test on the comparison copy ("4x+ included usage than Pro" vs "Over 13.3x included
  // monthly credits than Pro"), so multipliers on this page are not compared; prices and credits are.
  'https://github.com/features/copilot/plans': { mode: 'playwright', waitFor: () => !document.querySelector('[class*="Skeleton"]'), ignore: [/^multiplier /] },
  // help.openai.com answers 403 to non-browser clients.
  'https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers': { mode: 'playwright' },
};

const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const UA_BOT = 'PlanROI-source-check/1.0 (+https://planroi.pages.dev/methodology/)';

// ---------- fetching ----------
let browser, ctx;
async function getText(url, cfg) {
  if (cfg.mode === 'playwright' && USE_PW) {
    if (!browser) {
      const { chromium } = await import('playwright');
      browser = await chromium.launch();
      ctx = await browser.newContext({ userAgent: UA_BROWSER, locale: 'en-US', timezoneId: 'America/New_York', viewport: { width: 1366, height: 900 } });
    }
    const pg = await ctx.newPage();
    try {
      const r = await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (!r || r.status() >= 400) throw new Error(`HTTP ${r ? r.status() : 'no response'}`);
      if (/just a moment|attention required|access denied/i.test(await pg.title())) throw new Error('bot challenge page');
      await pg.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      if (cfg.waitFor) await pg.waitForFunction(cfg.waitFor, null, { timeout: 20000 }).catch(() => { if (!cfg.waitOptional) throw new Error('page loaded but content never finished rendering'); });
      const text = await pg.evaluate(() => {
        const scope = document.querySelector('main') || document.body;
        scope.querySelectorAll('nav, aside, footer, [role=navigation]').forEach(e => e.remove());
        return scope.innerText;
      });
      return { text, mode: 'playwright' };
    } finally { await pg.close(); }
  }
  if (cfg.mode === 'playwright' && !USE_PW) throw new Error('needs --playwright');
  const r = await fetch(url, { headers: { 'user-agent': UA_BOT, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return { text: htmlToText(await r.text()), mode: 'fetch' };
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: '-', mdash: '-', le: '≤', ge: '≥', times: '×', hellip: '...' };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e.toLowerCase()] ?? m));
function removeElements(html, tags) {
  const re = new RegExp(`<(/?)(${tags.join('|')})\\b[^>]*>`, 'gi');
  let out = '', depth = 0, last = 0, m;
  while ((m = re.exec(html))) {
    if (!m[1]) { if (depth === 0) out += html.slice(last, m.index); depth++; }
    else if (depth > 0) { depth--; if (depth === 0) last = re.lastIndex; }
  }
  return depth === 0 ? out + html.slice(last) : out;
}
function htmlToText(html) {
  html = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = html.match(/<main\b[^>]*>([\s\S]*)<\/main>/i);
  if (main) html = main[1];
  html = removeElements(html, ['nav', 'aside', 'footer']);
  return decode(html.replace(/\s+/g, ' ')
    .replace(/<br\s*\/?>|<\/?(p|div|li|ul|ol|h\d|tr|td|th|section|article|table|dt|dd|summary|details|button|header)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
}

// ---------- fact extraction ----------
const norm = t => t.replace(/([a-z])\d{1,2}(?=[\s.,;:)]|$)/gm, '$1') // footnote markers: "limits2", "Pro6"
  .replace(/[\u00a0\u2009\u202f\u200b]/g, ' ').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\u2060|⁠/g, '');
const num = s => s.replace(/,/g, '');
// Short plan keywords per source ("ChatGPT Plus (incl. Codex)" -> "Plus", "Copilot Pro+" -> "Pro+").
const planWord = p => p.plan.replace(/\(.*?\)/g, '').replace(/\b(ChatGPT|Claude|Google|AI|Copilot|Gemini|Cursor)\b/g, '').trim().split(/\s+/)[0];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function extractFacts(text, planWords) {
  text = norm(text);
  const facts = new Set();
  const flat = text.replace(/\s+/g, ' ');
  // Prices. Per-token / per-search / per-hour API prices are not plan prices and are ignored.
  for (const m of flat.matchAll(/(US\$|CA\$|C\$|A\$|\$|€|£)\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?![\d,.]*\s?[KMB]\b)/g)) {
    const after = flat.slice(m.index + m[0].length, m.index + m[0].length + 40);
    if (/^\s*(USD\s*)?(\/|per)\s*(1K\s*|1M\s*|million\s*)?(MTok|M tokens|tokens?|searches|session-hour|hours?|minutes?|containers?|image|request)/i.test(after)) continue;
    let unit = '';
    const u = after.match(/^\s*(\+)?\s*(USD|CAD)?\s*(?:(?:\/|per)\s*(user|seat)\s*)?(?:\/|per)\s*(month|mo|year|yr)\b/i);
    if (u) unit = (u[3] ? `/${u[3].toLowerCase()}` : '') + (/^y/i.test(u[4]) ? '/year' : '/month');
    else if (/^\s*(if |when )?billed monthly/i.test(after)) unit = '/month';
    const cur = m[1] === 'C$' ? 'CA$' : m[1];
    facts.add(`price ${cur}${num(m[2])}${unit}`);
  }
  // Usage multipliers (5x, 20x, 2.5x).
  for (const m of flat.matchAll(/(?<![\w.$])(\d+(?:\.\d+)?)\s?[x×](?![a-z0-9])(\+?)/gi)) facts.add(`multiplier ${m[1]}x${m[2]}`);
  // Credits / messages / requests / completions / storage.
  for (const m of flat.matchAll(/(?<![\w.$-])((?:\d[\d,.]*\s?-\s?)?\d{1,3}(?:,\d{3})+|(?:\d[\d,.]*\s?-\s?)?\d+(?:\.\d+)?)\s?(?:[A-Z][a-z]+\s){0,2}(credits?|messages?|requests?|completions?|chats?|GB|TB|seats?)\b/g))
    facts.add(`quantity ${num(m[1]).replace(/\s/g, '')} ${m[2].toLowerCase().replace(/s$/, '').replace(/^(gb|tb)$/, x => x.toUpperCase())}`);
  // Context windows / token counts (27K, 1M token).
  for (const m of flat.matchAll(/(?<![\w.$])(\d+(?:\.\d+)?)\s?([KM])\b(?!\s?(?:\/|per|USD|searches|requests))/g)) facts.add(`context ${m[1]}${m[2]}`);
  // Numeric ranges such as per-5h message estimates ("15-160", "350-3,000"); skips date-like pairs.
  for (const m of flat.matchAll(/(?<![\w.$-])(\d{1,3}(?:,\d{3})*)\s?-\s?(\d{1,3}(?:,\d{3})*)(?![\d,.]*[x%\w-])/g))
    if (Number(num(m[1])) < Number(num(m[2]))) facts.add(`range ${num(m[1])}-${num(m[2])}`);
  // Limit / reset statements tied to plan names, reduced to a wording-independent signature.
  const planRes = planWords.map(w => [w, new RegExp(`(?<![\\w])${esc(w)}(?![\\w+])`)]);
  const sentences = text.split(/\n+/).flatMap(l => l.split(/(?<=[.!?])\s+(?=[A-Z])/)).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const s of sentences) {
    if (!/\b(limits?|resets?|refresh(es)?|allowance|caps?|unlimited|sessions?|weekly)\b|\b(5|five)[- ]hours?\b/i.test(s)) continue;
    const who = planRes.filter(([, re]) => re.test(s)).map(([w]) => w);
    if (!who.length) continue;
    const sig = new Set();
    if (/\b(5|five)[- ]hours?\b/i.test(s)) sig.add('5-hour');
    if (/\bweek(ly)?\b/i.test(s)) sig.add('weekly');
    if (/\b(daily|per day|each day)\b/i.test(s)) sig.add('daily');
    if (/\bmonthly\b|\bper month\b/i.test(s)) sig.add('monthly');
    if (/\bno (\w+[- ])?(\w+ )?(rate )?limits?\b/i.test(s)) sig.add('no-limit');
    if (/\bunlimited\b/i.test(s)) sig.add('unlimited');
    for (const n of s.matchAll(/(?<![A-Za-z\d.])(\d+(?:[.,]\d+)*)(%|x|K|M)?(?![\d])/g)) if (n[2] || num(n[1]).replace(/\..*/, '').length >= 2) sig.add(num(n[1]) + (n[2] || ''));
    if (sig.size) facts.add(`limit [${[...new Set(who)].sort().join(', ')}] ${[...sig].sort().join(' ')}`);
  }
  // A bare amount ("$20") is redundant when the same amount is also stated with a period ("$20/month").
  for (const f of [...facts]) if (/^price \D*[\d.]+\/(month|year)$/.test(f)) facts.delete(f.replace(/\/.*$/, ''));
  return [...facts].sort();
}

const describe = f => f.replace(/^price /, 'price ').replace(/^limit \[(.*?)\] /, 'limit statement for $1: ');
const priceVal = f => (f.match(/^price (\D*)([\d.]+)/) || []).slice(1);

// Prices plans.json claims for each plan, with the currency they're quoted in.
function expectedPrices(p) {
  const out = [];
  const add = (v, cur, label) => [v].flat().forEach(x => typeof x === 'number' && out.push({ v: x, cur, label }));
  add(p.price_usd_month, '$', 'monthly'); add(p.price_annual_equiv, '$', 'annual equiv.'); add(p.price_cad_month, 'CA$', 'monthly (CAD)');
  return out;
}
const fmt = (cur, v) => `${cur}${Number.isInteger(v) ? v : v.toFixed(2)}`;
function checkPlans(facts, srcPlans) {
  const prices = facts.filter(f => f.startsWith('price ')).map(priceVal);
  const has = (cur, v) => prices.some(([c, x]) => c === cur && Math.abs(Number(x) - v) < 0.005);
  const curOnPage = new Set(prices.map(([c]) => c));
  const res = [];
  for (const p of srcPlans) for (const e of expectedPrices(p)) {
    if (!curOnPage.has(e.cur)) res.push({ plan: p.plan, e, status: 'n/a' });
    else res.push({ plan: p.plan, e, status: has(e.cur, e.v) ? 'ok' : 'missing' });
  }
  return res;
}

// ---------- main ----------
const fname = u => u.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').replace(/_$/, '') + '.json';
const short = u => u.replace(/^https?:\/\//, '').replace(/\/$/, '');
const urls = [...new Set(plans.flatMap(p => [p.source, p.price_source].filter(Boolean)))];
const plansFor = u => plans.filter(p => p.source === u || p.price_source === u);
const pricedBy = u => plans.filter(p => (p.price_source || p.source) === u);

await fs.mkdir(SNAP, { recursive: true });
const cache = new Map();
async function factsFor(url) {
  if (!cache.has(url)) cache.set(url, (async () => {
    const cfg = { mode: 'fetch', ...SOURCES[url] };
    if (FORCE_MODE) cfg.mode = FORCE_MODE;
    const { text, mode } = await getText(url, cfg);
    let facts = extractFacts(text, [...new Set(plansFor(url).map(planWord))]);
    const renderedPrices = facts.filter(f => f.startsWith('price '));
    if (cfg.volatilePrices) facts = facts.filter(f => !f.startsWith('price '));
    if (cfg.ignore) facts = facts.filter(f => !cfg.ignore.some(re => re.test(f)));
    if (PRINT) console.error(`--- ${url} [${mode}]\n${facts.join('\n')}`);
    return { mode, facts, renderedPrices };
  })().catch(e => ({ error: e.message })));
  return cache.get(url);
}

const changes = [], warnings = [], mismatches = [], unchanged = [], created = [];
for (const url of urls) {
  const cfg = SOURCES[url] || {};
  const r = await factsFor(url);
  if (r.error || cfg.volatilePrices) {
    let w = r.error ? `**${short(url)}**: fetch failed (${r.error})` : `**${short(url)}**: prices not compared on this page${r.renderedPrices.length ? '' : ' (not rendered this run)'}`;
    if (cfg.knownBlocked) w += ` — known blocked source (${cfg.knownBlocked})`;
    if (!r.error && r.renderedPrices.length) {
      const chk = checkPlans(r.renderedPrices, plansFor(url)).filter(c => c.status !== 'n/a');
      w += `. Rendered prices: ` + chk.map(c => `${c.plan} ${fmt(c.e.cur, c.e.v)} ${c.status === 'ok' ? '✓' : '✗'}`).join('; ');
    }
    if (cfg.fallback) {
      const fb = await Promise.all(cfg.fallback.map(factsFor));
      const ok = fb.filter(x => !x.error).flatMap(x => x.facts);
      const used = cfg.fallback.filter((u, i) => !fb[i].error).map(short);
      if (ok.length) {
        const chk = checkPlans(ok, plansFor(url)).filter(c => c.status !== 'n/a');
        w += `. Fallback (${used.join(', ')}): ` + chk.map(c => `${c.plan} ${fmt(c.e.cur, c.e.v)} ${c.status === 'ok' ? '✓' : '✗ not found'}`).join('; ');
        if (chk.some(c => c.status === 'missing')) mismatches.push(...chk.filter(c => c.status === 'missing').map(c => `${c.plan}: plans.json ${fmt(c.e.cur, c.e.v)} not found on fallback pages for ${short(url)}`));
      } else w += '. Fallback pages also failed; skipped.';
    }
    warnings.push(w);
    if (r.error) continue;
  }
  const f = path.join(SNAP, fname(url));
  const prev = JSON.parse(await fs.readFile(f, 'utf8').catch(() => 'null'));
  if (!cfg.volatilePrices) for (const c of checkPlans(r.facts, pricedBy(url)))
    if (c.status === 'missing') mismatches.push(`${c.plan}: plans.json ${c.e.label} ${fmt(c.e.cur, c.e.v)} not listed on ${short(url)}`);
    else if (c.status === 'n/a') mismatches.push(`${c.plan}: plans.json ${c.e.label} ${fmt(c.e.cur, c.e.v)} not comparable (${short(url)} shows no ${c.e.cur} prices)`);
  const save = async () => { if (!DRY) await fs.writeFile(f, JSON.stringify({ url, mode: r.mode, facts: r.facts }, null, 1) + '\n'); };
  if (!prev) { created.push(`${short(url)} (${r.facts.length} facts)`); await save(); continue; }
  if (prev.mode !== r.mode) { warnings.push(`**${short(url)}**: fetched via ${r.mode} but snapshot was taken via ${prev.mode}; not compared`); continue; }
  const prevPrices = prev.facts.filter(x => x.startsWith('price ')).length, curPrices = r.facts.filter(x => x.startsWith('price ')).length;
  if ((prevPrices && !curPrices) || r.facts.length < prev.facts.length * 0.5) {
    warnings.push(`**${short(url)}**: page returned ${r.facts.length} facts / ${curPrices} prices (snapshot ${prev.facts.length} / ${prevPrices}); looks like a broken or blocked render, not compared`); continue;
  }
  const A = new Set(prev.facts), B = new Set(r.facts);
  const removed = prev.facts.filter(x => !B.has(x)), added = r.facts.filter(x => !A.has(x));
  if (!removed.length && !added.length) { unchanged.push(short(url)); continue; }
  // Pair removed/added prices with the plans.json plans that quote them: "Plan X price $A -> $B".
  const lines = [];
  const addedPrices = added.filter(x => x.startsWith('price '));
  const usedRem = new Set(), usedAdd = new Set();
  for (const rem of removed.filter(x => x.startsWith('price '))) {
    const [cur, v] = priceVal(rem);
    const who = pricedBy(url).filter(p => expectedPrices(p).some(e => e.cur === cur && Math.abs(e.v - Number(v)) < 0.005));
    if (!who.length) continue;
    const unit = rem.replace(/^price \D*[\d.]+/, '');
    const cand = addedPrices.filter(a => !usedAdd.has(a) && a.replace(/^price \D*[\d.]+/, '') === unit);
    usedRem.add(rem);
    if (cand.length === 1) { usedAdd.add(cand[0]); lines.push(`${who.map(p => p.plan).join(' / ')} price ${rem.slice(6)} → ${cand[0].slice(6)}`); }
    else lines.push(`${who.map(p => p.plan).join(' / ')} price ${rem.slice(6)} no longer listed`);
  }
  for (const x of removed) if (!usedRem.has(x)) lines.push(`removed: ${describe(x)}`);
  for (const x of added) if (!usedAdd.has(x)) lines.push(`added: ${describe(x)}`);
  changes.push({ url, lines });
  if (UPDATE) await save();
}
if (browser) await browser.close();

const total = changes.reduce((n, c) => n + c.lines.length, 0);
let out = `# PlanROI source check ${new Date().toISOString().slice(0, 10)}\n\n`;
out += `${urls.length} sources · **${total} fact change(s)** in ${changes.length} source(s) · ${warnings.length} warning(s)\n`;
if (changes.length) out += `\n## Fact changes\n` + changes.map(c => `\n**${short(c.url)}**\n` + c.lines.map(l => `- ${l}`).join('\n')).join('\n') + '\n';
if (warnings.length) out += `\n## Warnings (not changes)\n` + warnings.map(w => `- ${w}`).join('\n') + '\n';
if (mismatches.length) out += `\n## plans.json vs live pages\n` + mismatches.map(w => `- ${w}`).join('\n') + '\n';
if (created.length) out += `\n## New snapshots\n` + created.map(w => `- ${w}`).join('\n') + '\n';
if (unchanged.length) out += `\nUnchanged: ${unchanged.join(', ')}\n`;
await fs.writeFile(path.join(root, 'change-report.md'), out);
console.log(out);
if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `changed=${changes.length}\n`);
