const { sequelize } = require('../config/db');
const { config } = require('../config/env');

let ready = false;

const ensureNewsletterTable = async () => {
  if (ready) return;

  const schema = config.dbSchema;

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "${schema}"."newsletter_subscribers" (
      id          SERIAL PRIMARY KEY,
      email       VARCHAR(255) NOT NULL UNIQUE,
      is_active   BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  ready = true;
};

module.exports = { ensureNewsletterTable };
