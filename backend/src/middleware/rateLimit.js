import rateLimit from 'express-rate-limit';
const handler = (req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests', requestId: req.id } });
export const limiter = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, handler });
