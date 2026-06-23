const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const path = require("path");
const crypto = require("crypto");
const { config } = require("./env");

const s3Client =
  config.s3AccessKeyId && config.s3SecretAccessKey && config.s3Bucket
    ? new S3Client({
        region: config.s3Region,
        credentials: {
          accessKeyId: config.s3AccessKeyId,
          secretAccessKey: config.s3SecretAccessKey,
        },
        // Disable automatic checksums — pre-signed PUT URLs used by browsers
        // cannot satisfy the CRC32 header that SDK v3 adds by default.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      })
    : null;

/**
 * Returns a short-lived pre-signed PUT URL the browser can upload to directly,
 * plus the permanent public URL where the video will live after upload.
 */
const generateS3PresignedUploadUrl = async (fileName = "video.webm", contentType = "video/webm") => {
  if (!s3Client) {
    throw new Error("S3 is not configured. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET in .env");
  }

  const ext = path.extname(fileName) || ".webm";
  const key = `product-videos/${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;

  const command = new PutObjectCommand({
    Bucket: config.s3Bucket,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 }); // valid 5 min

  // Prefer CloudFront domain so videos are served via CDN, not direct S3
  const baseUrl = config.cloudfrontUrl
    ? config.cloudfrontUrl.replace(/\/$/, "")
    : `https://${config.s3Bucket}.s3.${config.s3Region}.amazonaws.com`;
  const publicUrl = `${baseUrl}/${key}`;

  return { uploadUrl, publicUrl };
};

module.exports = { generateS3PresignedUploadUrl };
