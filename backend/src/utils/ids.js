import crypto from 'node:crypto';
export const uuid = () => crypto.randomUUID();
export const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
export const ticketRef = (prefix) => `${prefix}${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
