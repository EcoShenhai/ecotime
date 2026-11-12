#!/usr/bin/env node
// EcoTime clock-health collector (§9.5). Read-only and unprivileged: runs as `nobody` from a systemd timer, reads
// systemd-timesyncd through timedatectl, and writes one JSON state file atomically. It never changes the clock (T6)
// and needs no node_modules. A clock step is detected by comparing wall-clock and monotonic (uptime) progress (T4).
//   node scripts/collect-clock.js [state-file]      default: $STATE_DIRECTORY/clock-state.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseTimesyncStatus, parseShow } from '../src/services/clock-health/timesyncd.js';

const file = process.argv[2] || path.join(process.env.STATE_DIRECTORY || '/var/lib/ecotime-collector', 'clock-state.json');
const run = (args) => execFileSync('timedatectl', args, { encoding: 'utf8', timeout: 5000, env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' } });
const uptimeS = () => Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);

let prev = null; try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
const out = { host: os.hostname(), daemon: 'systemd-timesyncd', collectedAt: new Date().toISOString(), uptimeS: uptimeS(), collector: 'ecotime-collector/1' };
try {
  Object.assign(out, parseShow(run(['show', '-p', 'NTPSynchronized', '-p', 'NTP', '-p', 'Timezone'])));
  Object.assign(out, parseTimesyncStatus(run(['timesync-status'])));
} catch (e) { out.error = (e.code || e.message || 'error').toString().slice(0, 80); }
// step detection: wall-clock progress versus monotonic progress since the previous sample
if (prev && Number.isFinite(prev.uptimeS) && prev.collectedAt && out.uptimeS > prev.uptimeS) {
  const wall = (Date.parse(out.collectedAt) - Date.parse(prev.collectedAt)) / 1000; const mono = out.uptimeS - prev.uptimeS;
  out.lastStepS = +(wall - mono).toFixed(3);
  out.stepDetectedAt = Math.abs(wall - mono) > 1 ? out.collectedAt : prev.stepDetectedAt || null;
  if (Math.abs(wall - mono) > 1) out.stepSizeS = +(wall - mono).toFixed(3); else if (prev.stepSizeS) out.stepSizeS = prev.stepSizeS;
}
const tmp = `${file}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(out) + '\n', { mode: 0o644 });
fs.renameSync(tmp, file);
if (process.argv.includes('--print')) console.log(JSON.stringify(out));
