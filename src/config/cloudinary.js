const cloudinary = require("cloudinary").v2;
const { config } = require("./env");

cloudinary.config({
  cloud_name: config.cloudinaryCloudName,
  api_key: config.cloudinaryApiKey,
  api_secret: config.cloudinaryApiSecret,
});

const uploadBufferToCloudinary = (buffer, folder = "vns-saree/products") =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "image",
      },
      (error, result) => {
        if (error) return reject(error);
        return resolve(result);
      },
    );

    stream.end(buffer);
  });

const uploadVideoToCloudinary = (buffer, folder = "vns-saree/product-videos") =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "video",
      },
      (error, result) => {
        if (error) return reject(error);
        return resolve(result);
      },
    );

    stream.end(buffer);
  });

const generateUploadSignature = (folder) => {
  const timestamp = Math.round(Date.now() / 1000);
  const paramsToSign = { timestamp, folder };
  const signature = cloudinary.utils.api_sign_request(paramsToSign, config.cloudinaryApiSecret);
  return {
    signature,
    timestamp,
    folder,
    cloudName: config.cloudinaryCloudName,
    apiKey: config.cloudinaryApiKey,
  };
};

/**
 * Extracts the Cloudinary public_id from a stored image URL.
 * Handles optional transformation segments and the version segment, e.g.
 *   https://res.cloudinary.com/<cloud>/image/upload/w_600/f_auto,q_auto/v123/folder/abc.jpg
 *   → "folder/abc"
 * Returns null for non-Cloudinary URLs.
 */
const cloudinaryPublicId = (url) => {
  if (!url || typeof url !== "string" || !url.includes("cloudinary.com")) return null;
  const afterUpload = url.split("/upload/")[1];
  if (!afterUpload) return null;
  let parts = afterUpload.split("?")[0].split("/");
  // Drop everything up to and including the version segment (vNNNN),
  // which also removes any transformation segments before it.
  const vIndex = parts.findIndex((p) => /^v\d+$/.test(p));
  if (vIndex >= 0) parts = parts.slice(vIndex + 1);
  const joined = parts.join("/");
  return joined.replace(/\.[^/.]+$/, "") || null; // strip file extension
};

/**
 * Deletes a single image from Cloudinary given its public URL.
 * Never throws — media cleanup should not block a product update/delete.
 */
const destroyCloudinaryImage = async (url) => {
  const publicId = cloudinaryPublicId(url);
  if (!publicId) return false;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
    return true;
  } catch (err) {
    console.error(`[cloudinary] Failed to delete ${publicId}:`, err.message);
    return false;
  }
};

module.exports = {
  cloudinary,
  uploadBufferToCloudinary,
  uploadVideoToCloudinary,
  generateUploadSignature,
  destroyCloudinaryImage,
};
