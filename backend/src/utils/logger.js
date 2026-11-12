// JSON-line logger with redaction (L5, §13.2). Passwords, codes, tokens, secrets, coordinates, addresses and search
// text never reach logs.
const REDACT_KEY = /pass(word)?|secret|token|authorization|cookie|otp|code$|totp|pepper|answers|feedback|body|note|description|apikey|api_key|^lat|^lon|^lng|latitude|longitude|coord|location|address|waypoint|origin|destination|^q$|query|geometry|bbox/i;
const REDACT_VALUE = [
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<jwt>'],
  [/otpauth:\/\/[^\s"']+/gi, '<otpauth>'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 <redacted>'],
  [/\betk_[A-Za-z0-9]+_[A-Za-z0-9_-]+/g, '<api-key>'],
  [/whsec_[A-Za-z0-9_-]+/g, '<webhook-secret>'],
  [/-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/g, '<coords>'],
];

export function redact(value, depth = 0) {
  if (depth > 6) return '<depth>';
  if (typeof value === 'string') return REDACT_VALUE.reduce((s, [re, r]) => s.replace(re, r), value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redact(value.message), code: value.code };
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = REDACT_KEY.test(k) ? '<redacted>' : redact(v, depth + 1);
    return out;
  }
  return value;
}

function write(level, msg, fields) {
  if (process.env.LOG_SILENT === '1') return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg: redact(String(msg)), ...redact(fields || {}) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const logger = { info: (m, f) => write('info', m, f), warn: (m, f) => write('warn', m, f), error: (m, f) => write('error', m, f) };
