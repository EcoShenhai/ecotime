// Zod in jitless mode (no eval, matches the strict CSP used by the web app as well).
import { z } from 'zod';
import { badRequest } from './errors.js';
z.config({ jitless: true });
export { z };
export function parse(schema, value) {
  const r = schema.safeParse(value);
  if (!r.success) {
    const first = r.error.issues[0];
    throw badRequest('INVALID_INPUT', `${first.path.join('.') || 'body'}: ${first.message}`);
  }
  return r.data;
}
