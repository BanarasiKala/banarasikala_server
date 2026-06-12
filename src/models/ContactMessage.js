const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db");

const ContactMessage = sequelize.define(
  "ContactMessage",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false },
    phone: { type: DataTypes.STRING, allowNull: false },
    subject: { type: DataTypes.STRING, allowNull: false },
    message: { type: DataTypes.TEXT, allowNull: false },
    is_read: { type: DataTypes.BOOLEAN, defaultValue: false },
  },
  { tableName: "contact_messages", timestamps: true }
);

module.exports = ContactMessage;
