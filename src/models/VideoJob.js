const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db");

/**
 * One row per source video being optimised by MediaConvert.
 *
 * Keyed on the source URL rather than on a product/reel id, because the same upload can be
 * referenced from several tables (a video lives in products.videos, reels.video_url,
 * box_sections.videos …). Optimising is a property of the FILE, not of whatever happens to
 * point at it, so one row covers every reference and the unique constraint is what stops a
 * second job being submitted for a file already in flight.
 */
const VideoJob = sequelize.define(
  "VideoJob",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    source_url: {
      type: DataTypes.TEXT,
      allowNull: false,
      unique: true,
      comment: "The original CDN url as stored in the app tables",
    },
    output_url: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: "Where the optimised file will live; written before the job is submitted",
    },
    job_id: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "MediaConvert job id, for polling",
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "pending",
      comment: "pending | processing | complete | error | skipped",
    },
    poster_url: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: "Frame grabbed from the clip, used as the <video poster>",
    },
    preview_url: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: "Tile-sized silent variant, for thumbnails that would otherwise stream the master",
    },
    card_url: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: "Rail-sized silent variant, between the preview and the master",
    },
    source_table: {
      type: DataTypes.STRING(64),
      allowNull: true,
      comment: "Which table referenced the file; decides the encode profile",
    },
    source_bytes: { type: DataTypes.BIGINT, allowNull: true },
    output_bytes: { type: DataTypes.BIGINT, allowNull: true },
    attempts: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: "Submission attempts; a file that keeps failing is parked rather than retried forever",
    },
    error_message: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    tableName: "video_jobs",
    schema: "vns_saree",
    underscored: true,
    timestamps: true,
  },
);

module.exports = VideoJob;
