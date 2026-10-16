#!/usr/bin/env node
// Fetch each source URL, extract pricing/limits text, diff vs data/snapshots, write change report.
// Usage: node scripts/check-sources.mjs [--update] [--playwright]
import fs from 'node:fs/promises'; import path from 'node:path'; import crypto from 'node:crypto';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SNAP = path.join(root, 'data/snapshots'); const args = process.argv.slice(2);
const UPDATE = args.includes('--update'); const USE_PW = args.includes('--playwright') || process.env.USE_PLAYWRIGHT === '1';
const plans = JSON.parse(await fs.readFile(path.join(root, 'src/data/plans.json'), 'utf8')).plans;
const urls = [...new Set(plans.flatMap(p => [p.source, p.price_source].filter(Boolean)))];
const KEY = /(\$|€|£|CA\$|price|\/mo|month|year|annual|limit|usage|credit|request|message|token|context|hour|weekly|session|included|unlimited|\d+x)/i;

let browser;
async function getHtml(url) {
  if (USE_PW) {
    try { if (!browser) { const { chromium } = await import('playwright'); browser = await chromium.launch(); }
      const pg = await browser.newPage(); await pg.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      const t = await pg.evaluate(() => document.body.innerText); await pg.close(); return { text: t, raw: false };
    } catch (e) { console.warn(`playwright failed for ${url}: ${e.message}; falling back to fetch`); }
  }
  const r = await fetch(url, { headers: { 'user-agent': 'PlanROI-source-check/1.0 (+https://planroi.pages.dev/methodology/)' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`); return { text: await r.text(), raw: true };
}
function toText(html) {
  return html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|td|th|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
}
const extract = t => [...new Set(t.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l.length > 2 && l.length < 400 && KEY.test(l)))].join('\n');
function diff(a, b) { const A = new Set(a.split('\n')), B = new Set(b.split('\n'));
  return [...[...A].filter(x => !B.has(x)).map(x => '- ' + x), ...[...B].filter(x => !A.has(x)).map(x => '+ ' + x)]; }
const fname = u => u.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').replace(/_$/, '') + '.txt';

await fs.mkdir(SNAP, { recursive: true });
const report = []; let changed = 0, errors = 0;
for (const url of urls) {
  const f = path.join(SNAP, fname(url));
  try {
    const { text, raw } = await getHtml(url); const cur = extract(raw ? toText(text) : text);
    const prev = await fs.readFile(f, 'utf8').catch(() => null);
    if (prev === null) { await fs.writeFile(f, cur); report.push(`## ${url}\nNEW snapshot saved (${cur.split('\n').length} lines)\n`); continue; }
    if (prev === cur) { report.push(`## ${url}\nunchanged\n`); continue; }
    changed++; const d = diff(prev, cur);
    report.push(`## ${url}\nCHANGED (${d.length} lines, sha ${crypto.createHash('sha1').update(cur).digest('hex').slice(0, 8)})\n\`\`\`diff\n${d.slice(0, 200).join('\n')}\n\`\`\`\n`);
    if (UPDATE) await fs.writeFile(f, cur);
  } catch (e) { errors++; report.push(`## ${url}\nERROR: ${e.message}\n`); }
}
if (browser) await browser.close();
const out = `# PlanROI source check ${new Date().toISOString()}\n\nSources: ${urls.length} · changed: ${changed} · errors: ${errors}\n\n${report.join('\n')}`;
await fs.writeFile(path.join(root, 'change-report.md'), out); console.log(out);
if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
