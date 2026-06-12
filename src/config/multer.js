const multer = require("multer");

const ALLOWED_VIDEO_MIME_TYPES = ["video/mp4", "video/webm", "video/quicktime"];

const productFileFilter = (req, file, cb) => {
  const isImage = file.mimetype.startsWith("image/");
  const isVideo = ALLOWED_VIDEO_MIME_TYPES.includes(file.mimetype);
  if (isImage || isVideo) {
    cb(null, true);
  } else {
    cb(Object.assign(new Error("Only image and video files (MP4, WebM, MOV) are allowed."), { status: 400 }), false);
  }
};

const imageFileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith("image/")) {
    cb(null, true);
  } else {
    cb(Object.assign(new Error("Only image files are allowed."), { status: 400 }), false);
  }
};

const productUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  // No MIME filter — mobile browsers (iPhone) send unreliable MIME types.
  // Cloudinary rejects files it cannot process, which is the real guard.
});

const feedbackUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: imageFileFilter,
});

module.exports = { productUpload, feedbackUpload };
