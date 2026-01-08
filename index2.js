/**
 * COMPLETE FIXED SERVER CODE
 * This fixes the YouTube URL issue and proper video streaming
 * Copy-paste this entire file to replace your backend server
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { transcribeAndSaveVtt } = require("./transcribe");
const {
  uploadVideoFile,
  fetchRemoteToCloudinary,
  uploadRemoteUrlToCloudinaryStream,
  cloudinary,
} = require("./cloudinaryClient");
const { pipeline } = require("stream");
const { promisify } = require("util");
const streamPipeline = promisify(pipeline);
const { execSync } = require("child_process");

const app = express();
const PORT = process.env.PORT || 4000;

// ============ MIDDLEWARE ============
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:3000",
      "http://localhost:5000",
      "http://localhost:5174",
    ],
    credentials: true,
    methods: ["GET", "POST", "HEAD", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Range"],
    exposedHeaders: ["Content-Length", "Content-Range", "Accept-Ranges"],
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============ STORAGE (MULTER) ============
const uploadDir = path.join(__dirname, "tmp", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".webm";
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 8);
    cb(null, `${timestamp}-${random}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      "video/mp4",
      "video/webm",
      "video/mpeg",
      "audio/mpeg",
      "audio/wav",
      "audio/webm",
      "application/octet-stream",
    ];
    if (allowedMimes.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Invalid file type: ${file.mimetype}`));
  },
});

// ============ STATIC ============
const subtitlesDir = path.join(__dirname, "public", "subtitles");
if (!fs.existsSync(subtitlesDir))
  fs.mkdirSync(subtitlesDir, { recursive: true });
app.use("/subtitles", express.static(subtitlesDir));

// ============ CONSTANTS ============
const MAX_BYTES = 800 * 1024 * 1024; // 800 MB
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

// ============ HELPER: Extract YouTube Direct URL ============
async function getYouTubeDirectUrl(youtubeUrl) {
  try {
    console.log("🎬 Extracting YouTube video URL...");
    // Using quiet mode to get just the URL
    const command = `yt-dlp -f "best[ext=mp4]" --get-url --quiet "${youtubeUrl}"`;
    const directUrl = execSync(command, { encoding: "utf-8" }).trim();

    if (!directUrl) {
      throw new Error("No URL extracted");
    }

    console.log(
      "✅ Extracted direct URL (first 100 chars):",
      directUrl.substring(0, 100) + "..."
    );
    return directUrl;
  } catch (err) {
    console.error("❌ yt-dlp failed:", err.message);
    throw new Error(
      "Could not extract video from YouTube. Video may be private or unavailable."
    );
  }
}

// ============ HELPER: Download Video from URL to Local ============
async function downloadVideoFromUrl(url, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  let ext = ".mp4";

  try {
    const urlPath = new URL(url).pathname || "";
    const urlExt = path.extname(urlPath);
    if (
      urlExt &&
      [".mp4", ".webm", ".mpeg", ".wav", ".m4a", ".mov", ".flv"].includes(
        urlExt.toLowerCase()
      )
    ) {
      ext = urlExt;
    }
  } catch (e) {
    console.warn("Could not parse URL for extension, using .mp4");
  }

  const filename = `${timestamp}-${random}${ext}`;
  const filePath = path.join(uploadDir, filename);

  console.log("🌐 Downloading video from URL:", url.substring(0, 100) + "...");
  console.log("💾 Saving to:", filePath);

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await axios({
      method: "GET",
      url,
      responseType: "stream",
      maxRedirects: 10,
      timeout: 30000,
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "*/*",
      },
      validateStatus: (status) => true,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Remote returned status ${response.status} ${response.statusText}`
      );
    }

    const contentType =
      (response.headers && response.headers["content-type"]) || "";
    const contentLengthRaw =
      response.headers && response.headers["content-length"];
    const contentLength = contentLengthRaw
      ? parseInt(contentLengthRaw, 10)
      : null;

    console.log("📦 Content-Type:", contentType);
    console.log("📦 Content-Length:", contentLength);

    if (contentLength && contentLength > MAX_BYTES) {
      throw new Error(
        `Remote file too large (${contentLength} bytes). Limit is ${MAX_BYTES} bytes.`
      );
    }

    const writer = fs.createWriteStream(filePath, { flags: "w" });
    await streamPipeline(response.data, writer);

    const stats = fs.statSync(filePath);
    if (!stats || stats.size === 0) {
      fs.unlinkSync(filePath);
      throw new Error("Downloaded file is empty");
    }

    if (stats.size > MAX_BYTES) {
      fs.unlinkSync(filePath);
      throw new Error("Downloaded file exceeds allowed size after download");
    }

    console.log("✅ Download complete, file size:", stats.size, "bytes");
    return filePath;
  } catch (err) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {}

    if (err?.name === "AbortError") {
      throw new Error("Download aborted (timeout)");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ============ ROUTES ============
app.get("/health", (req, res) =>
  res.json({ ok: true, message: "Backend is running" })
);

// Upload file and transcribe
app.post("/upload-audio", upload.single("file"), async (req, res) => {
  if (!req.file)
    return res
      .status(400)
      .json({ error: "No file uploaded. Use field 'file'" });

  const filePath = req.file.path;
  console.log("📂 File uploaded:", filePath);

  try {
    let cloudResult = null;

    try {
      console.log("☁️ Uploading file to Cloudinary...");
      cloudResult = await uploadVideoFile(filePath, {
        resource_type: "video",
        folder: "ai_subtitles/uploads",
      });
      console.log("☁️ Cloudinary upload done:", cloudResult.secure_url);
    } catch (cloudErr) {
      console.warn(
        "⚠️ Cloudinary upload failed:",
        cloudErr.message || cloudErr
      );
    }

    let transcribeResult;
    if (cloudResult && cloudResult.secure_url) {
      transcribeResult = await transcribeAndSaveVtt({
        remoteUrl: cloudResult.secure_url,
      });
    } else {
      transcribeResult = await transcribeAndSaveVtt({ filePath });
    }

    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      console.warn("⚠️ Could not delete temp file:", e.message);
    }

    const payload = {
      ok: true,
      text: transcribeResult.text || "",
      segments: transcribeResult.segments || [],
      vttUrl: transcribeResult.vttUrlPath,
      vttFilename: transcribeResult.vttFilename,
    };

    if (cloudResult && cloudResult.secure_url) {
      payload.cloudinary = {
        secure_url: cloudResult.secure_url,
        public_id: cloudResult.public_id,
        resource_type: cloudResult.resource_type,
      };
    }

    return res.json(payload);
  } catch (err) {
    console.error("❌ Error in /upload-audio:", err.message);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {}
    return res
      .status(500)
      .json({ error: err.message || "Transcription failed" });
  }
});

/**
 * MAIN FIX: Upload from URL endpoint
 * This handles:
 * 1. YouTube URLs - extracts direct download link
 * 2. Regular video URLs - downloads locally then uploads to Cloudinary
 * 3. Direct streams - uses Cloudinary's upload_stream for efficiency
 */
// ---------------------------
// FIXED /upload-from-url
// ---------------------------
app.post("/upload-from-url", async (req, res) => {
  let tempFile = null;

  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "Missing URL" });

    console.log("🎥 Received URL:", url);

    // Basic YouTube detection (covers youtube.com and youtu.be)
    const isYT = url.includes("youtube.com") || url.includes("youtu.be");

    let cloudResult = null;

    if (isYT) {
      // === YouTube path: download to disk with yt-dlp, then upload to Cloudinary ===
      console.log("📺 YouTube detected → downloading with yt-dlp...");

      const outName = `yt-${Date.now()}.mp4`;
      tempFile = path.join(uploadDir, outName);

      // Build command and run. Adjust format string if you want different formats.
      const cmd = `yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/mp4" -o "${tempFile}" "${url}"`;
      console.log("Running:", cmd);

      try {
        execSync(cmd, { stdio: "inherit", env: process.env });
      } catch (ytErr) {
        console.error("yt-dlp failed:", ytErr);
        // If yt-dlp fails, try returning a helpful message
        throw new Error(
          "yt-dlp download failed. Make sure yt-dlp is installed and accessible on the server."
        );
      }

      // Upload the downloaded file to Cloudinary (or your uploader)
      console.log("☁️ Uploading downloaded YouTube file to Cloudinary...");
      cloudResult = await uploadVideoFile(tempFile, {
        resource_type: "video",
        folder: "ai_subtitles/uploads",
      });
      console.log("☁️ Cloudinary upload complete:", cloudResult.secure_url);
    } else {
      // === Non-YouTube path: try Cloudinary remote fetch first, then fallback to downloading ===
      console.log(
        "Skipping HEAD validation — attempting Cloudinary remote fetch first."
      );

      try {
        console.log("☁️ Cloudinary fetch attempt...");
        cloudResult = await fetchRemoteToCloudinary(url, {
          resource_type: "video",
          folder: "ai_subtitles/uploads",
        });
        console.log("☁️ Cloudinary fetched:", cloudResult.secure_url);
      } catch (fetchErr) {
        console.warn("⚠️ Cloudinary fetch failed:", fetchErr && fetchErr.message);

        // Fallback: download to disk and then upload
        try {
          console.log("🌐 Falling back to direct download...");
          tempFile = await downloadVideoFromUrl(url); // should return local file path
          if (!tempFile || !fs.existsSync(tempFile)) {
            throw new Error("Fallback download did not produce a file.");
          }

          console.log("☁️ Uploading fallback-downloaded file to Cloudinary...");
          cloudResult = await uploadVideoFile(tempFile, {
            resource_type: "video",
            folder: "ai_subtitles/uploads",
          });
          console.log("☁️ Cloudinary upload complete:", cloudResult.secure_url);
        } catch (downloadErr) {
          console.error("❌ Fallback download/upload failed:", downloadErr);
          // Provide a helpful error that matches previous behavior
          return res.status(400).json({
            error:
              downloadErr && downloadErr.message
                ? downloadErr.message
                : "Remote returned status 403 Forbidden",
          });
        }
      }
    }

    // === Transcribe (shared step) ===
    console.log("📝 Transcribing remote file:", cloudResult.secure_url);
    const trans = await transcribeAndSaveVtt({
      remoteUrl: cloudResult.secure_url,
    });

    // === Cleanup local file if present ===
    if (tempFile && fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch (unlinkErr) {
        console.warn("Cleanup failed (could not remove temp file):", unlinkErr);
      }
    }

    // Return consistent response structure
    return res.json({
      ok: true,
      cloudinaryUrl: cloudResult.secure_url,
      text: trans.text,
      segments: trans.segments,
      vttUrl: trans.vttUrlPath,
    });
  } catch (err) {
    console.error("URL ERROR:", err);

    // Cleanup on error
    if (tempFile && fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch (e) {
        console.warn("Failed to unlink tempFile during error cleanup:", e);
      }
    }

    return res.status(400).json({
      error: err && err.message ? err.message : "Failed to process video from URL",
    });
  }
});



// ============ VIDEO PROXY ============
// Use this ONLY if you're serving videos from your own server
// For Cloudinary videos, this isn't needed
app.get("/proxy/video", async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({ error: "Missing 'url' parameter" });
  }

  console.log("[proxy] Proxying video request...");

  try {
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "*/*",
    };

    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const response = await axios.get(targetUrl, {
      responseType: "stream",
      timeout: 60000,
      maxRedirects: 10,
      headers,
      validateStatus: () => true,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    console.log("[proxy] Remote status:", response.status);

    if (response.status < 200 || response.status >= 300) {
      return res.status(502).json({
        error: `Remote server error: ${response.status} ${response.statusText}`,
      });
    }

    if (response.headers["content-type"])
      res.set("Content-Type", response.headers["content-type"]);
    if (response.headers["content-length"])
      res.set("Content-Length", response.headers["content-length"]);

    res.set("Accept-Ranges", "bytes");

    if (response.headers["content-range"]) {
      res.set("Content-Range", response.headers["content-range"]);
      res.status(206);
    }

    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Range, Content-Type");
    res.set(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges"
    );

    response.data.pipe(res);

    response.data.on("error", (err) => {
      console.error("[proxy] Stream error:", err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: "Failed to stream video" });
      } else {
        res.end();
      }
    });

    req.on("abort", () => {
      console.log("[proxy] Client aborted");
      response.data.destroy();
    });
  } catch (err) {
    console.error("[proxy] Error:", err.message);
    if (!res.headersSent) {
      return res
        .status(502)
        .json({ error: "Proxy failed", details: err.message });
    }
  }
});

app.options("/proxy/video", (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Range, Content-Type");
  res.set(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges"
  );
  res.set("Access-Control-Max-Age", "3600");
  res.status(200).end();
});

app.listen(PORT, () => {
  console.log(`🚀 AI Subtitle Backend running on http://localhost:${PORT}`);
  console.log(`📤 Upload file: POST /upload-audio`);
  console.log(`🌐 Upload from URL: POST /upload-from-url`);
  console.log(`📝 Subtitles: /subtitles/{filename}.vtt`);
  console.log(`🎥 Video proxy: GET /proxy/video?url={videoUrl}`);
});

module.exports = app;
