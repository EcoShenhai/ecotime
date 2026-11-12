// One JSON error shape with a stable code and the request id (§9). No stack traces, no secrets.
export class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status; this.code = code; this.extra = extra;
  }
}
export const badRequest = (code = 'INVALID_INPUT', msg = 'Invalid request') => new ApiError(400, code, msg);
export const unauthorized = (code = 'UNAUTHORIZED', msg = 'Sign-in required') => new ApiError(401, code, msg);
export const forbidden = (code = 'FORBIDDEN', msg = 'Not allowed') => new ApiError(403, code, msg);
export const notFound = (code = 'NOT_FOUND', msg = 'Not found') => new ApiError(404, code, msg);
export const conflict = (code = 'CONFLICT', msg = 'Conflict') => new ApiError(409, code, msg);
export const preconditionFailed = (code = 'VERSION_CONFLICT', msg = 'The stored version has changed') => new ApiError(412, code, msg);
export const unavailable = (code = 'UNAVAILABLE', msg = 'Temporarily unavailable') => new ApiError(503, code, msg);
export const locked = (code = 'LOCKED', msg = 'Locked', extra) => new ApiError(423, code, msg, extra);
// EcoTime stable codes (§7.4).
export const invalidTimeZone = (zone) => new ApiError(400, 'INVALID_TIME_ZONE', `Unknown IANA time zone: ${String(zone).slice(0, 80)}`);
export const invalidRecurrence = (msg) => new ApiError(400, 'INVALID_RECURRENCE', msg);
export const limitExceeded = (msg) => new ApiError(422, 'LIMIT_EXCEEDED', msg);
