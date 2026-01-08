const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const axios = require('axios');
const http = require('http');
const https = require('https');

function assertEnv() {
  const missing = [];
  if (!process.env.CLOUDINARY_CLOUD_NAME) missing.push('CLOUDINARY_CLOUD_NAME');
  if (!process.env.CLOUDINARY_API_KEY) missing.push('CLOUDINARY_API_KEY');
  if (!process.env.CLOUDINARY_API_SECRET) missing.push('CLOUDINARY_API_SECRET');
  if (missing.length) {
    const msg = `Missing Cloudinary env vars: ${missing.join(', ')}. Set them and restart the server.`;
    console.error(msg);
    throw new Error(msg);
  }
}
assertEnv();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

console.log('☁️ Cloudinary configured for:', process.env.CLOUDINARY_CLOUD_NAME);

async function pingCloudinary() {
  try {
    return await cloudinary.api.ping();
  } catch (err) {
    throw new Error(`Cloudinary ping failed: ${err.message || err}`);
  }
}

function uploadVideoFile(localFilePath, options = {}) {
  if (!fs.existsSync(localFilePath)) {
    return Promise.reject(new Error('Local file does not exist: ' + localFilePath));
  }
  const uploadOptions = Object.assign({ resource_type: 'video' }, options);
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(localFilePath, uploadOptions, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

function fetchRemoteToCloudinary(remoteUrl, options = {}) {
  if (!remoteUrl || typeof remoteUrl !== 'string') {
    return Promise.reject(new Error('Invalid remoteUrl'));
  }
  const uploadOptions = Object.assign({ resource_type: 'video' }, options);
  console.log('[cloudinaryClient] fetchRemoteToCloudinary called for', remoteUrl);
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(remoteUrl, uploadOptions, (err, result) => {
      if (err) {
        const msg = (err && err.message) ? err.message : String(err);
        return reject(new Error(msg));
      }
      resolve(result);
    });
  });
}

async function uploadRemoteUrlToCloudinaryStream(remoteUrl, options = {}) {
  if (!remoteUrl || typeof remoteUrl !== 'string') {
    return Promise.reject(new Error('Invalid remoteUrl'));
  }
  const uploadOptions = Object.assign({ resource_type: 'video' }, options);

  const ATTEMPTS = 3;
  const BASE_TIMEOUT_MS = 300000;
  const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 60000, timeout: BASE_TIMEOUT_MS });
  const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 60000, timeout: BASE_TIMEOUT_MS });

  let lastErr = null;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await axios({
        method: 'GET',
        url: remoteUrl,
        responseType: 'stream',
        maxRedirects: 10,
        timeout: BASE_TIMEOUT_MS,
        httpAgent,
        httpsAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ai-subtitler/1.0)',
          Accept: '*/*',
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: (s) => true,
      });

      if (!response || response.status < 200 || response.status >= 300) {
        throw new Error(`Remote returned status ${response?.status || 'unknown'}`);
      }

      const cl = response.headers['content-length'];
      if (cl && Number(cl) === 0) throw new Error('Remote content-length is zero');

      const result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(uploadOptions, (err, result) => {
          if (err) return reject(err);
          resolve(result);
        });

        response.data.on('error', (err) => {
          try { uploadStream.destroy(); } catch (e) {}
          reject(new Error('Stream error while reading remote: ' + (err.message || err)));
        });

        uploadStream.on('error', (err) => reject(new Error('Cloudinary upload_stream error: ' + (err.message || err))));

        response.data.pipe(uploadStream);
      });

      return result;
    } catch (err) {
      lastErr = err;
      console.warn(`[cloudinaryClient] stream attempt ${attempt} failed:`, err.message || err);

      if (attempt < ATTEMPTS) {
        const delay = Math.round((Math.pow(2, attempt) * 1000) + Math.random() * 500);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
  }

  throw new Error(lastErr ? lastErr.message || String(lastErr) : 'Stream failed after retries');
}

function deleteAsset(publicId, options = {}) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.destroy(publicId, options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

module.exports = {
  cloudinary,
  pingCloudinary,
  uploadVideoFile,
  fetchRemoteToCloudinary,
  uploadRemoteUrlToCloudinaryStream,
  deleteAsset,
};