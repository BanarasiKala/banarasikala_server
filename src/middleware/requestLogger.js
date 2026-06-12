const { config } = require('../config/env');

const redact = (value) => {
  if (!value || typeof value !== 'object') return value;
  const clone = { ...value };
  const sensitive = ['password', 'newPassword', 'token', 'refreshToken', 'accessToken'];
  sensitive.forEach((key) => {
    if (clone[key] !== undefined) clone[key] = '[REDACTED]';
  });
  return clone;
};

const requestLogger = (req, res, next) => {
  const start = Date.now();
  const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  req.reqId = reqId;

  const safeBody = redact(req.body);
  if (!config.isProduction) {
    console.log(`[REQ ${reqId}] ${req.method} ${req.originalUrl}`, {
      query: req.query,
      body: safeBody,
    });
  }

  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[RES ${reqId}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });

  next();
};

module.exports = requestLogger;
