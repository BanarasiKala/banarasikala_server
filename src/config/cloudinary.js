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

module.exports = { cloudinary, uploadBufferToCloudinary, uploadVideoToCloudinary };
