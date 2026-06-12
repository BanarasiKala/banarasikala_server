const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db");
const { config } = require("../config/env");

const FEEDBACK_COLUMNS = {
  order_id: { type: DataTypes.INTEGER, allowNull: true },
  order_item_id: { type: DataTypes.INTEGER, allowNull: true },
  product_id: { type: DataTypes.INTEGER, allowNull: true },
  title: { type: DataTypes.STRING, allowNull: true },
  images: { type: DataTypes.JSONB, allowNull: true, defaultValue: [] },
};

let feedbackColumnsReady = false;

const ensureFeedbackColumns = async () => {
  if (feedbackColumnsReady) return;

  const queryInterface = sequelize.getQueryInterface();
  const table = { tableName: "feedbacks", schema: config.dbSchema };
  const columns = await queryInterface.describeTable(table);

  for (const [column, definition] of Object.entries(FEEDBACK_COLUMNS)) {
    if (!columns[column]) {
      await queryInterface.addColumn(table, column, definition);
    }
  }

  feedbackColumnsReady = true;
};

module.exports = { FEEDBACK_COLUMNS, ensureFeedbackColumns };
