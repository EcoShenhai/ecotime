// Copies the 72 languages from CPAMind's registry (the platform source, Integration §4) and makes sure
// every language has a locale file. New files start as English placeholders marked "_untranslated".
// Usage: node scripts/sync-registry.mjs [/srv/apps/cpamind/frontend/src/international/registry.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] || '/srv/apps/b2x-manager/frontend/src/international/registry.json'; // CPAMind registry with native names
const out = path.join(here, '../src/international/registry.json');
const locales = path.join(here, '../src/i18n/locales');

if (fs.existsSync(src)) {
  const reg = JSON.parse(fs.readFileSync(src, 'utf8'));
  const languages = (reg.languages || []).map(({ code, name, native, dir }) => ({ code, name: native || name, dir: dir === 'rtl' ? 'rtl' : 'ltr' }));
  if (languages.length < 72) throw new Error(`registry has ${languages.length} languages, expected 72`);
  fs.writeFileSync(out, JSON.stringify({ generatedFrom: 'CPAMind international registry (native names)', languages }, null, 1) + '\n');
  console.log(`registry: ${languages.length} languages from ${src}`);
} else console.log(`registry source not found (${src}); keeping ${path.relative(process.cwd(), out)}`);

const en = JSON.parse(fs.readFileSync(path.join(locales, 'en.json'), 'utf8'));
const { languages } = JSON.parse(fs.readFileSync(out, 'utf8'));
let created = 0, topped = 0;
for (const { code } of languages) {
  if (code === 'en') continue;
  const f = path.join(locales, `${code}.json`);
  const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  const next = { _untranslated: 'true', ...(cur || {}) };
  let added = 0;
  for (const [k, v] of Object.entries(en)) if (!(k in next)) { next[k] = v; added++; }
  if (!cur) created++; else if (added) topped++;
  if (!cur || added) fs.writeFileSync(f, JSON.stringify(next, null, 1) + '\n');
}
console.log(`locales: ${created} created, ${topped} topped up with new English keys`);
