// npm run seed -- --registry <CPAMind registry.json>
// Loads the 72 languages and 205 territories (read-only copy of the CPAMind registry) with the IANA zones that the tz
// database lists for each country (zone1970.tab / zone.tab), and records the host's current upstream time source.
// Safe to run again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/env.js';
import { createSequelize } from '../src/db/index.js';
import { assertZone } from '../src/services/timezones/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export function zonesByCountry(files) {
  const map = new Map();
  for (const f of files) {
    let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [codes, , zone] = line.split('\t');
      if (!codes || !zone) continue;
      for (const c of codes.split(',')) { if (!map.has(c)) map.set(c, new Set()); map.get(c).add(zone.trim()); }
    }
  }
  return map;
}

export async function seed(sequelize, registry, { zoneFiles = ['/usr/share/zoneinfo/zone1970.tab', '/usr/share/zoneinfo/zone.tab'] } = {}, log = console.log) {
  const langs = registry.languages?.length ? registry.languages : JSON.parse(fs.readFileSync(path.join(here, '../../frontend/src/international/registry.json'), 'utf8')).languages;
  const zones = zonesByCountry(zoneFiles);
  const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
  return sequelize.transaction(async (t) => {
    for (const l of langs) await q(`INSERT INTO languages (code, name, dir) VALUES (:c, :n, :d) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, dir = EXCLUDED.dir`, { c: l.code, n: l.name, d: l.dir === 'rtl' ? 'rtl' : 'ltr' }, t);
    const none = [];
    for (const x of registry.territories || []) {
      const z = [...(zones.get(x.code) || [])].filter((id) => { try { return Boolean(assertZone(id)); } catch { return false; } }).sort();
      if (!z.length) none.push(x.code);
      await q(`INSERT INTO territories (code, name, registry_status, languages, time_zones, synced_at) VALUES (:c, :n, :s, :l, :z, now())
               ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, registry_status = EXCLUDED.registry_status, languages = EXCLUDED.languages, time_zones = EXCLUDED.time_zones, synced_at = now()`,
      { c: x.code, n: x.name, s: x.status || null, l: JSON.stringify(Array.isArray(x.languages) ? x.languages : []), z: JSON.stringify(z) }, t);
    }
    // the upstream in use today (§9.2: distribution default, one server at a time; finding F1)
    await q(`INSERT INTO time_sources (host_label, operator, authenticated, tier, active, notes) VALUES ('ntp.ubuntu.com', 'Canonical', false, 2, true,
             'Distribution default used by systemd-timesyncd; one server at a time (finding F1: add independent operators in Phase 1)') ON CONFLICT (host_label) DO NOTHING`, {}, t);
    const [[c]] = await q(`SELECT (SELECT count(*) FROM languages)::int AS languages, (SELECT count(*) FROM territories)::int AS territories,
                                  (SELECT count(*) FROM territories WHERE jsonb_array_length(time_zones) > 1)::int AS "multiZone", (SELECT count(*) FROM time_sources)::int AS sources`, {}, t);
    log(`languages ${c.languages}, territories ${c.territories} (${c.multiZone} with several zones${none.length ? `; no zone listed for ${none.join(',')}` : ''}), time sources ${c.sources}`);
    return c;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf('--registry'); const file = i > 0 ? process.argv[i + 1] : null;
  if (!file) { console.error('usage: npm run seed -- --registry /srv/apps/cpamind/frontend/src/international/registry.json'); process.exit(2); }
  const sequelize = createSequelize(loadConfig());
  try { await seed(sequelize, JSON.parse(fs.readFileSync(file, 'utf8'))); } finally { await sequelize.close(); }
}
