const crypto = require("crypto");

const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || "").trim();
const apiKey = String(process.env.CLOUDINARY_API_KEY || "").trim();
const apiSecret = String(process.env.CLOUDINARY_API_SECRET || "").trim();
const uploadFolder = String(process.env.CLOUDINARY_FOLDER || "china-bedsheet-erp").trim();

const isCloudinaryConfigured = () => Boolean(cloudName && apiKey && apiSecret);

const createCloudinaryError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const buildSignature = (params) => {
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return crypto
    .createHash("sha1")
    .update(`${query}${apiSecret}`)
    .digest("hex");
};

const uploadImageDataUrl = async (dataUrl) => {
  if (!isCloudinaryConfigured()) {
    throw createCloudinaryError(
      "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.",
      400,
    );
  }
  if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:image")) {
    throw createCloudinaryError("Invalid image data. Expected image data URL.", 400);
  }
  if (typeof fetch !== "function" || typeof FormData === "undefined") {
    throw createCloudinaryError(
      "Server runtime does not support image upload transport.",
      500,
    );
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = {
    folder: uploadFolder,
    timestamp,
  };
  const signature = buildSignature(paramsToSign);

  const form = new FormData();
  form.append("file", dataUrl);
  form.append("api_key", apiKey);
  form.append("timestamp", String(timestamp));
  form.append("folder", uploadFolder);
  form.append("signature", signature);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`,
    {
      method: "POST",
      body: form,
    },
  );

  const payload = await response.json();
  if (!response.ok) {
    throw createCloudinaryError(payload?.error?.message || "Cloudinary upload failed.", 502);
  }

  return payload?.secure_url || payload?.url || null;
};

const normalizeImageUrlList = (input) => {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((entry) => String(entry || "").trim())
    .filter((entry) => entry.startsWith("http://") || entry.startsWith("https://"));
};

const uploadImageSet = async ({ imageUrls, imageDataUrls }) => {
  const directUrls = normalizeImageUrlList(imageUrls);
  const dataUrls = Array.isArray(imageDataUrls)
    ? imageDataUrls.filter((entry) => typeof entry === "string" && entry.startsWith("data:image"))
    : [];
  if (!isCloudinaryConfigured()) {
    return [...directUrls, ...dataUrls];
  }
  if (dataUrls.length === 0) {
    return directUrls;
  }
  const uploadedUrls = (
    await Promise.all(
      dataUrls.map(async (dataUrl) => {
        try {
          return await uploadImageDataUrl(dataUrl);
        } catch (error) {
          throw createCloudinaryError(
            `Image upload failed: ${error.message}`,
            error?.statusCode || 400,
          );
        }
      }),
    )
  ).filter(Boolean);

  return [...directUrls, ...uploadedUrls];
};

module.exports = {
  isCloudinaryConfigured,
  uploadImageSet,
};
