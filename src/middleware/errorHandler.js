const { config } = require('../config/env');

const sanitizeSequelizeError = (error) => {
  const name = error.name || '';
  if (name === 'SequelizeUniqueConstraintError') {
    return { status: 409, message: 'This record already exists.' };
  }
  if (name === 'SequelizeValidationError') {
    return { status: 400, message: 'Invalid input data.' };
  }
  if (name === 'SequelizeForeignKeyConstraintError') {
    return { status: 400, message: 'Related record not found.' };
  }
  if (name.startsWith('Sequelize') || name.startsWith('SequelizeDatabase')) {
    return { status: 500, message: 'Internal server error' };
  }
  return null;
};

const errorHandler = (error, req, res, next) => {
  const sequelizeOverride = sanitizeSequelizeError(error);
  const status = sequelizeOverride?.status || Number(error.status || error.statusCode) || 500;
  const rawMessage = error.message || 'Internal server error';
  const message = sequelizeOverride?.message ||
    (config.isProduction && status >= 500 ? 'Internal server error' : rawMessage);

  console.error(`[ERR ${req?.reqId || 'n/a'}] ${req?.method || ''} ${req?.originalUrl || ''}`, {
    status,
    message: rawMessage,
    stack: error.stack,
    detail: error?.response?.data || null,
  });

  return res.status(status).json({
    message,
    code: error.code || null,
    reqId: req?.reqId || null,
  });
};

module.exports = errorHandler;
