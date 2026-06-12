const { Sequelize } = require("sequelize");
const { config } = require("./env");

const SYNC_DATABASE = false;
const SYNC_OPTIONS = { alter: true };

if (!config.databaseUrl) {
  console.error("CRITICAL ERROR: DATABASE_URL is not defined in environment variables.");
}

const shouldUseSsl = (url) => url.includes("supabase.co") || url.includes("render.com");

const sequelize = new Sequelize(config.databaseUrl, {
  dialect: "postgres",
  logging: false,
  dialectOptions: {
    ssl: shouldUseSsl(config.databaseUrl) ? {
      require: true,
      rejectUnauthorized: false,
    } : false,
  },
  define: {
    schema: config.dbSchema,
    timestamps: false,
  },
});

const runSchemaSync = async () => {
  if (!SYNC_DATABASE) {
    console.log("Database schema sync skipped.");
    return;
  }

  console.log("Database schema sync started.");
  await sequelize.sync(SYNC_OPTIONS);
  console.log("Database schema synchronized.");
};

const connectDB = async () => {
  try {
    await sequelize.authenticate();
    console.log("PostgreSQL connected successfully.");
    console.log(`Database schema: ${config.dbSchema}`);

    await runSchemaSync();
  
  } catch (error) {
    console.error("Unable to connect to the database:", error);
    process.exit(1);
  }
};

module.exports = { sequelize, connectDB };
