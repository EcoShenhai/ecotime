import { ApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found', requestId: req.id } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err?.type === 'entity.too.large') err = new ApiError(413, 'TOO_LARGE', 'Request too large');
  else if (err?.type === 'entity.parse.failed') err = new ApiError(400, 'BAD_JSON', 'Malformed JSON');
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, requestId: req.id, ...(err.extra || {}) } });
  }
  logger.error('unhandled', { requestId: req.id, path: req.path, err });
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong', requestId: req.id } });
}
