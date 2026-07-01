const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const path = require("path");
const crypto = require("crypto");
const { config } = require("./env");

// Object-key prefixes this app owns and is allowed to create/delete.
const MANAGED_FOLDERS = ["product-videos", "reels"];

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
const generateS3PresignedUploadUrl = async (fileName = "video.webm", contentType = "video/webm", folder = "product-videos") => {
  if (!s3Client) {
    throw new Error("S3 is not configured. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET in .env");
  }

  const safeFolder = MANAGED_FOLDERS.includes(folder) ? folder : "product-videos";
  const ext = path.extname(fileName) || ".webm";
  const key = `${safeFolder}/${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;

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

/**
 * Extracts the S3 object key from a stored video URL.
 * Works for both CloudFront URLs (https://dXXX.cloudfront.net/product-videos/abc.mp4)
 * and direct S3 URLs (https://bucket.s3.region.amazonaws.com/product-videos/abc.mp4).
 * Returns null if the URL is not a video we manage.
 */
const s3KeyFromUrl = (url) => {
  if (!url || typeof url !== "string") return null;
  try {
    const { pathname } = new URL(url);
    const key = decodeURIComponent(pathname.replace(/^\/+/, ""));
    // Only touch keys in folders we manage
    return MANAGED_FOLDERS.some((folder) => key.startsWith(`${folder}/`)) ? key : null;
  } catch {
    return null;
  }
};

/**
 * Deletes a single video object from S3 given its public URL.
 * Silently ignores URLs that are not S3-managed videos. Never throws —
 * media cleanup should not block a product update/delete.
 */
const deleteS3Object = async (url) => {
  const key = s3KeyFromUrl(url);
  if (!key || !s3Client) return false;
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: key }));
    return true;
  } catch (err) {
    console.error(`[s3] Failed to delete ${key}:`, err.message);
    return false;
  }
};

module.exports = { generateS3PresignedUploadUrl, deleteS3Object };
