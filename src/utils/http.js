class AppError extends Error {
  constructor(message, status = 500, code = null, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const ok = (res, data = null, message = 'OK', status = 200) =>
  res.status(status).json({ success: true, message, data, reqId: res.req?.reqId || null });

const fail = (res, message = 'Request failed', status = 400, code = null, details = null) =>
  res.status(status).json({ success: false, message, code, details, reqId: res.req?.reqId || null });

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { AppError, ok, fail, asyncHandler };
