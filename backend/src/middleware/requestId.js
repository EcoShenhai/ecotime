import crypto from 'node:crypto';
export function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  next();
}
