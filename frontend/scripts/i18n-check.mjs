// Fails the build if any key used in the code is missing from en.json, or if any of the 72 languages
// lacks a locale file or a key. Reports how many languages are still English placeholders.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '../src');
const locales = path.join(srcDir, 'i18n/locales');
const en = JSON.parse(fs.readFileSync(path.join(locales, 'en.json'), 'utf8'));
const { languages } = JSON.parse(fs.readFileSync(path.join(srcDir, 'international/registry.json'), 'utf8'));
// Families of keys built at run time: every member must exist.
const CLOCK = ['synchronized', 'degraded', 'unsynchronized', 'stale', 'unknown'];
const RES = ['unique', 'ambiguous', 'nonexistent'];
const DYNAMIC = {
  'clock.': [...CLOCK, ...CLOCK.map((k) => `${k}.text`)], 'resolution.': [...RES, ...RES.map((k) => `${k}.text`)],
  'dst.gap.': ['shift_forward', 'skip'], 'dst.overlap.': ['first', 'second'],
  'freq.': ['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY', 'CUSTOM'], 'day.': ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'],
  'action.': ['record', 'email', 'webhook', 'record.text', 'email.text', 'webhook.text'],
  'sstatus.': ['active', 'paused', 'completed', 'failed', 'disabled'], 'exec.': ['running', 'succeeded', 'retrying', 'failed'],
  'event.': ['state_change', 'clock_step', 'source_change', 'ruleset_mismatch'], 'diversity.': ['single_source', 'multiple'],
  'orgKind.': ['personal', 'app', 'team'], 'orgStatus.': ['active', 'suspended'], 'clientStatus.': ['active', 'revoked'], 'whStatus.': ['active', 'disabled'], 'userStatus.': ['active', 'disabled'],
  'privacy.': ['identity', 'schedules', 'clock', 'logs', 'thirdparty', 'retention', 'contact'].flatMap((k) => [`${k}.title`, `${k}.text`]),
};
const used = new Set();
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) return walk(p);
  if (!/\.(tsx?|jsx?)$/.test(e.name)) return;
  const s = fs.readFileSync(p, 'utf8');
  for (const m of s.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
  for (const m of s.matchAll(/'((?:admin\.)?nav\.[a-zA-Z]+)'/g)) used.add(m[1]);
});
walk(srcDir);
for (const [p, ks] of Object.entries(DYNAMIC)) ks.forEach((k) => used.add(p + k));
const problems = [];
for (const k of used) if (!(k in en)) problems.push(`en.json missing "${k}"`);
if (languages.length !== 72) problems.push(`registry has ${languages.length} languages, expected 72`);
let placeholders = 0;
for (const { code } of languages) {
  if (code === 'en') continue;
  const f = path.join(locales, `${code}.json`);
  if (!fs.existsSync(f)) { problems.push(`missing locale ${code}.json`); continue; }
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const missing = Object.keys(en).filter((k) => !(k in d));
  if (missing.length) problems.push(`${code}.json missing ${missing.length} keys`);
  for (const [k, v] of Object.entries(d)) if (!k.startsWith('_') && typeof en[k] === 'string') {
    const want = (en[k].match(/\{\w+\}/g) || []).sort().join(); const got = (String(v).match(/\{\w+\}/g) || []).sort().join();
    if (want !== got) problems.push(`${code}.json "${k}" placeholders ${got || 'none'} != ${want}`);
  }
  if (d._untranslated === 'true') placeholders++;
}
console.log(`i18n: ${used.size} keys used, ${Object.keys(en).length} in en.json, ${languages.length} languages, ${placeholders} still English placeholders`);
if (problems.length) { console.error(problems.slice(0, 30).join('\n')); process.exit(1); }
