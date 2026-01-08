// index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const fsPromises = require("fs").promises;
const axios = require("axios");
const {
  transcribeAndSaveVtt,
  requestAssemblyAITranslation, // kept for compatibility but not used for translations
} = require("./transcribe");
const {
  uploadVideoFile,
  fetchRemoteToCloudinary,
  uploadRemoteUrlToCloudinaryStream,
  cloudinary,
} = require("./cloudinaryClient");
const { pipeline } = require("stream");
const { promisify } = require("util");
const streamPipeline = promisify(pipeline);
const { spawnSync } = require("child_process");

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

// ===== BODY PARSER SAFE GUARD =====
function isMultipart(req) {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  return ct.startsWith('multipart/');
}

// JSON parser for NON-multipart only
app.use((req, res, next) => {
  if (isMultipart(req)) return next();
  express.json({ limit: '50mb' })(req, res, next);
});

// URL-encoded parser for NON-multipart only
app.use((req, res, next) => {
  if (isMultipart(req)) return next();
  express.urlencoded({ extended: true })(req, res, next);
});


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
// serve subtitles with no-store so each translation is fetched fresh
app.use(
  "/subtitles",
  express.static(subtitlesDir, {
    setHeaders: (res, filePath) => {
      res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, proxy-revalidate"
      );
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("Surrogate-Control", "no-store");
    },
  })
);

// ============ CONSTANTS ============
const MAX_BYTES = 800 * 1024 * 1024; // 800 MB
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

// ============ HELPERS ============
function secToVttTimestamp(t) {
  const totalMs = Math.round((t || 0) * 1000);
  const ms = totalMs % 1000;
  let s = Math.floor(totalMs / 1000);
  const secs = s % 60;
  s = Math.floor(s / 60);
  const mins = s % 60;
  const hrs = Math.floor(s / 60);
  const pad = (n, z = 2) => String(n).padStart(z, "0");
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}.${String(ms).padStart(3, "0")}`;
}

// async function writeVttFromSegments(segments, outDir, baseName) {
//   const lines = ["WEBVTT", ""];
//   for (let i = 0; i < segments.length; i++) {
//     const s = segments[i] || {};
//     lines.push(String(i + 1));
//     lines.push(`${secToVttTimestamp(s.start)} --> ${secToVttTimestamp(s.end)}`);
//     lines.push((s.text || "").replace(/\r\n/g, "\n"));
//     lines.push("");
//   }
//   const filename = `${baseName}.${Date.now()}.vtt`;
//   const outPath = path.join(outDir, filename);
//   await fsPromises.mkdir(path.dirname(outPath), { recursive: true });
//   await fsPromises.writeFile(outPath, lines.join("\n"), "utf8");
//   return { path: outPath, filename, content: lines.join("\n") };
// }

function isExternalHttpUrl(u) {
  try {
    const parsed = new URL(u);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const h = parsed.hostname;
    if (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "::1" ||
      h.endsWith(".local")
    )
      return false;
    return true;
  } catch (e) {
    return false;
  }
}

// optional AssemblyAI translation helper (kept but not used in MyMemory flow)
async function produceAssemblyTranslatedVtt(transcriptId, targetLang) {
  if (!transcriptId || !targetLang) {
    console.log("⚠️ No transcriptId or targetLang provided for translation");
    return null;
  }

  try {
    console.log(
      `🌍 Requesting AssemblyAI translation: ${transcriptId} -> ${targetLang}`
    );

    if (typeof requestAssemblyAITranslation !== "function") {
      console.warn("⚠️ requestAssemblyAITranslation function not available");
      return null;
    }

    const res = await requestAssemblyAITranslation(transcriptId, targetLang);

    if (res) {
      if (res.vttUrlPath) return res.vttUrlPath;
      if (res.vttFilename)
        return `/subtitles/${encodeURIComponent(res.vttFilename)}`;
    }

    console.log("⚠️ Translation did not return a VTT URL");
    return null;
  } catch (err) {
    console.error(
      "❌ Translation failed:",
      err && err.message ? err.message : err
    );
    return null;
  }
}

// ============ HELPER: YouTube extraction & download ============
// async function getYouTubeDirectUrl(youtubeUrl) {
//   try {
//     console.log("🎬 Extracting YouTube video URL...");
//     const args = ["-f", "best[ext=mp4]", "--get-url", "--quiet", youtubeUrl];
//     const r = spawnSync("yt-dlp", args, { encoding: "utf8" });
//     if (r.error || r.status !== 0) {
//       throw r.error || new Error("yt-dlp failed with status " + r.status);
//     }
//     const directUrl = (r.stdout || "").trim();
//     if (!directUrl) throw new Error("No URL extracted");
//     return directUrl;
//   } catch (err) {
//     console.error("❌ yt-dlp failed:", err && err.message ? err.message : err);
//     throw new Error(
//       "Could not extract video from YouTube. Video may be private or unavailable."
//     );
//   }
// }

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
    // ignore, use default .mp4
  }

  const filename = `${timestamp}-${random}${ext}`;
  const filePath = path.join(uploadDir, filename);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await axios({
      method: "GET",
      url,
      responseType: "stream",
      maxRedirects: 10,
      timeout: 30000,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "*/*",
      },
      validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Remote returned status ${response.status} ${response.statusText}`
      );
    }

    const contentLengthRaw =
      response.headers && response.headers["content-length"];
    const contentLength = contentLengthRaw
      ? parseInt(contentLengthRaw, 10)
      : null;
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

    return filePath;
  } catch (err) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
    if (err?.name === "AbortError")
      throw new Error("Download aborted (timeout)");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ============ ROUTES ============
app.get("/", (req, res) => {
  res.json({ message: "Subtitle backend is running!" });
});
app.get("/health", (req, res) =>
  res.json({ ok: true, message: "Backend is running" })
);

// ============ UPLOAD & TRANSCRIBE ============
// Upload audio/file and transcribe
app.post("/upload-audio", upload.single("file"), async (req, res) => {
  if (!req.file)
    return res
      .status(400)
      .json({ error: "No file uploaded. Use field 'file'" });

  const filePath = req.file.path;
  const languageCode = req.body?.languageCode || "auto";
  const targetLang = req.body?.targetLang || null;

  console.log("📂 File uploaded:", filePath);
  console.log("🌐 Transcription language:", languageCode);
  console.log("🌍 Translation target:", targetLang || "none");

  try {
    let cloudResult = null;
    try {
      console.log("☁️ Uploading file to Cloudinary...");
      cloudResult = await uploadVideoFile(filePath, {
        resource_type: "video",
        folder: "ai_subtitles/uploads",
      });
      console.log("☁️ Cloudinary upload done:", cloudResult?.secure_url);
    } catch (cloudErr) {
      console.warn(
        "⚠️ Cloudinary upload failed:",
        cloudErr && cloudErr.message ? cloudErr.message : cloudErr
      );
    }

    let transcribeResult;
    if (cloudResult?.secure_url) {
      transcribeResult = await transcribeAndSaveVtt({
        remoteUrl: cloudResult.secure_url,
        languageCode,
      });
    } else {
      transcribeResult = await transcribeAndSaveVtt({ filePath, languageCode });
    }

    console.log(
      "✅ Transcription complete. TranscriptID:",
      transcribeResult?.transcriptId
    );

    // We do NOT run AssemblyAI translation here when using MyMemory-only flow.
    let translatedVttUrl = null;
    // If the frontend requests immediate translation using AssemblyAI this code path can be used,
    // but by default we leave translatedVttUrl null so client triggers /translate-subtitles (MyMemory)
    if (false && targetLang && transcribeResult?.transcriptId) {
      try {
        translatedVttUrl = await produceAssemblyTranslatedVtt(
          transcribeResult.transcriptId,
          targetLang
        );
      } catch (err) {
        console.warn(
          "AssemblyAI translation suppressed/failed:",
          err && err.message ? err.message : err
        );
      }
    }

    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}

    const payload = {
      ok: true,
      text: transcribeResult?.text || "",
      segments: transcribeResult?.segments || [],
      vttUrl:
        transcribeResult?.vttUrlPath ||
        (transcribeResult?.vttFilename
          ? `/subtitles/${encodeURIComponent(transcribeResult.vttFilename)}`
          : null),
      translatedVttUrl: translatedVttUrl || null,
      transcriptId: transcribeResult?.transcriptId || null,
      detectedLanguage: transcribeResult?.detectedLanguage || null,
    };

    if (cloudResult?.secure_url) {
      payload.cloudinary = {
        secure_url: cloudResult.secure_url,
        public_id: cloudResult.public_id,
        resource_type: cloudResult.resource_type,
      };
    }

    return res.json(payload);
  } catch (err) {
    console.error(
      "❌ Error in /upload-audio:",
      err && err.message ? err.message : err
    );
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
    return res.status(500).json({
      error: err && err.message ? err.message : "Transcription failed",
    });
  }
});

// Upload from URL and transcribe
app.post("/upload-from-url", async (req, res) => {
  let tempFile = null;
  try {
    const { url, languageCode, targetLang } = req.body || {};
    if (!url) return res.status(400).json({ error: "Missing URL" });

    if (!isExternalHttpUrl(url))
      return res.status(400).json({ error: "Invalid or disallowed URL" });

    console.log("🎥 Received URL:", url);
    console.log("🌐 Transcription language:", languageCode || "auto");
    console.log("🌍 Translation target:", targetLang || "none");

    const isYT = url.includes("youtube.com") || url.includes("youtu.be");
    let cloudResult = null;

    if (isYT) {
      console.log("📺 YouTube detected → downloading with yt-dlp...");
      const outName = `yt-${Date.now()}.mp4`;
      tempFile = path.join(uploadDir, outName);
      const args = [
        "-f",
        "bestvideo[ext=mp4]+bestaudio[ext=m4a]/mp4",
        "-o",
        tempFile,
        url,
      ];
      const r = spawnSync("yt-dlp", args, { stdio: "inherit" });
      if (r.status !== 0) {
        throw new Error(
          "yt-dlp download failed. Make sure yt-dlp is installed and accessible."
        );
      }
      console.log("☁️ Uploading downloaded YouTube file to Cloudinary...");
      cloudResult = await uploadVideoFile(tempFile, {
        resource_type: "video",
        folder: "ai_subtitles/uploads",
      });
      console.log("☁️ Cloudinary upload complete:", cloudResult?.secure_url);
    } else {
      console.log("☁️ Attempting Cloudinary remote fetch...");
      try {
        cloudResult = await fetchRemoteToCloudinary(url, {
          resource_type: "video",
          folder: "ai_subtitles/uploads",
        });
        console.log("☁️ Cloudinary fetched:", cloudResult?.secure_url);
      } catch (fetchErr) {
        console.warn(
          "⚠️ Cloudinary fetch failed:",
          fetchErr && fetchErr.message ? fetchErr.message : fetchErr
        );
        console.log("🌐 Falling back to direct download...");
        tempFile = await downloadVideoFromUrl(url);
        if (!tempFile || !fs.existsSync(tempFile))
          throw new Error("Fallback download failed.");
        console.log("☁️ Uploading fallback file to Cloudinary...");
        cloudResult = await uploadVideoFile(tempFile, {
          resource_type: "video",
          folder: "ai_subtitles/uploads",
        });
        console.log("☁️ Cloudinary upload complete:", cloudResult?.secure_url);
      }
    }

    console.log("📝 Transcribing remote file...");
    const trans = await transcribeAndSaveVtt({
      remoteUrl: cloudResult.secure_url,
      languageCode: languageCode || "auto",
    });

    console.log(
      "✅ Transcription complete. TranscriptID:",
      trans?.transcriptId
    );

    // We are MyMemory-only for translations. translatedVttUrl left null.
    let translatedVttUrl = null;
    try {
      if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch (_) {}

    return res.json({
      ok: true,
      cloudinaryUrl: cloudResult?.secure_url || null,
      text: trans?.text || "",
      segments: trans?.segments || [],
      vttUrl:
        trans?.vttUrlPath ||
        (trans?.vttFilename
          ? `/subtitles/${encodeURIComponent(trans.vttFilename)}`
          : null),
      translatedVttUrl: translatedVttUrl,
      transcriptId: trans?.transcriptId || null,
      detectedLanguage: trans?.detectedLanguage || null,
    });
  } catch (err) {
    console.error("❌ URL ERROR:", err && err.message ? err.message : err);
    if (tempFile && fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch (_) {}
    }
    return res.status(400).json({
      error:
        err && err.message ? err.message : "Failed to process video from URL",
    });
  }
});

// ---- Mirrors (auto-fallback)
const MIRRORS = [
  process.env.LIBRE_URL, // your chosen primary
  "https://libretranslate.de/translate",
  "https://translate.terraprint.co/translate",
  "https://translate.argosopentech.com/translate",
].filter(Boolean);

// ---- Translate fallback to mirrors
async function translateTextWithFallback(text, targetLang) {
  for (const mirror of MIRRORS) {
    try {
      const r = await axios.post(
        mirror,
        {
          q: text,
          source: "auto",
          target: targetLang.toLowerCase(),
          format: "text",
        },
        { timeout: 8000 }
      );

      if (r.data?.translatedText) return r.data.translatedText;
      // some mirrors return r.data.translated
      if (r.data?.translated) return r.data.translated;
    } catch (err) {
      console.warn(
        `⚠️ Mirror failed (${mirror}):`,
        err && err.message ? err.message : err
      );
    }
  }

  console.warn("❗ All mirrors failed — using original text");
  return text;
}

// ---- Build VTT helper
function buildVttFromSegments(segments) {
  const pad = (n, z = 2) => String(n).padStart(z, "0");

  const toVttTime = (sec) => {
    const totalMs = Math.round((sec || 0) * 1000);
    const ms = totalMs % 1000;
    let s = Math.floor(totalMs / 1000);
    const secs = s % 60;
    s = Math.floor(s / 60);
    const mins = s % 60;
    const hrs = Math.floor(s / 60);
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}.${String(ms).padStart(
      3,
      "0"
    )}`;
  };

  const lines = ["WEBVTT", ""];
  segments.forEach((s, i) => {
    lines.push(String(i + 1));
    lines.push(`${toVttTime(s.start)} --> ${toVttTime(s.end)}`);
    lines.push((s.text || "").replace(/\r\n/g, "\n"));
    lines.push("");
  });
  return lines.join("\n");
}

// ---- MyMemory translator (primary) with mirror fallback
async function translateWithMyMemory(text, srcLang, targetLang) {
  try {
    const short = String(text).slice(0, 120).replace(/\n/g, " ");
    console.log(
      `[MyMemory] request (${srcLang}→${targetLang}): "${short}${
        text.length > 120 ? "..." : ""
      }"`
    );
    const r = await axios.get("https://api.mymemory.translated.net/get", {
      params: { q: text, langpair: `${srcLang}|${targetLang}` },
      timeout: 9000,
    });
    const sample = {
      responseData: r.data?.responseData,
      matchesCount: Array.isArray(r.data?.matches)
        ? r.data.matches.length
        : null,
    };
    console.log("[MyMemory] response sample:", sample);
    const t = r.data?.responseData?.translatedText;
    if (t && t.length) return t;
  } catch (err) {
    console.warn("MyMemory error:", err && err.message ? err.message : err);
  }

  // fallback to mirrors
  try {
    const fallback = await translateTextWithFallback(text, targetLang);
    if (fallback && fallback !== text) {
      console.log("[MyMemory] fallback translated via mirrors");
      return fallback;
    }
  } catch (err) {
    console.warn(
      "Mirror fallback failed:",
      err && err.message ? err.message : err
    );
  }

  // last resort: return original
  return text;
}

// ============ TRANSLATION ROUTE (MyMemory-first) ============
const LANG_MAP_BACKEND = {
  english: "en",
  en: "en",
  hindi: "hi",
  hi: "hi",
  spanish: "es",
  es: "es",
  french: "fr",
  fr: "fr",
  chinese: "zh-CN",
  chinese_simplified: "zh-CN",
  chinese_traditional: "zh-TW",
  japanese: "ja",
  ja: "ja",
  korean: "ko",
  ko: "ko",
  german: "de",
  de: "de",
  italian: "it",
  it: "it",
  portuguese: "pt",
  pt: "pt",
  russian: "ru",
  ru: "ru",
  arabic: "ar",
  ar: "ar",
  turkish: "tr",
  tr: "tr",
};

function normLangBackend(l) {
  if (!l) return "auto";
  const s = String(l).trim();
  if (/^auto$/i.test(s)) return "auto";
  if (/^[A-Za-z]{2}(-[A-Za-z]{2,4})?$/.test(s)) {
    const parts = s.split("-");
    if (parts.length === 2)
      return parts[0].toLowerCase() + "-" + parts[1].toUpperCase();
    return s.toLowerCase();
  }
  const key = s.toLowerCase().replace(/\s+/g, "_").replace(/[()]/g, "");
  return LANG_MAP_BACKEND[key] || "auto";
}

// Script detection helper (quick Unicode heuristic)
function detectScriptFromTextSample(text) {
  if (!text) return null;
  // Devanagari (Hindi, Marathi, Nepali etc.)
  if (/[\u0900-\u097F]/.test(text)) return "hi";
  // Cyrillic
  if (/[\u0400-\u04FF]/.test(text)) return "ru";
  // Arabic
  if (/[\u0600-\u06FF]/.test(text)) return "ar";
  // CJK Unified Ideographs
  if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(text)) return "zh-CN";
  // Thai
  if (/[\u0E00-\u0E7F]/.test(text)) return "th";
  // Hebrew
  if (/[\u0590-\u05FF]/.test(text)) return "he";
  return null;
}

app.post("/translate-subtitles", async (req, res) => {
  try {
    const { segments, targetLang, detectedLanguage, transcriptId } =
      req.body || {};

    if (!targetLang) {
      return res.status(400).json({ ok: false, error: "targetLang required" });
    }

    console.log("[translate-subtitles] incoming payload:", {
      segmentsCount: Array.isArray(segments) ? segments.length : 0,
      targetLang,
      detectedLanguage,
      transcriptId: transcriptId
        ? String(transcriptId).slice(0, 12) + "..."
        : null,
    });

    const tgtLang = normLangBackend(targetLang);
    // start with provided detectedLanguage or 'auto'
    let srcLang = detectedLanguage ? normLangBackend(detectedLanguage) : "auto";

    // If segments exist, try quick script-based detection when srcLang is 'auto' or suspicious
    let toTranslateSegments = Array.isArray(segments) ? segments.slice() : [];

    if (
      (!toTranslateSegments || toTranslateSegments.length === 0) &&
      transcriptId
    ) {
      // attempt to fetch transcript words via AssemblyAI to build segments (only to build segments - we will still use MyMemory for translation)
      try {
        const API_KEY = process.env.ASSEMBLYAI_API_KEY;
        if (API_KEY) {
          const tRes = await axios.get(
            `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
            {
              headers: { Authorization: API_KEY },
              timeout: 10000,
            }
          );
          const transcript = tRes.data || {};
          const built = [];

          if (Array.isArray(transcript.words) && transcript.words.length > 0) {
            let seg = {
              start: transcript.words[0].start / 1000,
              end: null,
              text: "",
            };
            let blockTime = seg.start;
            for (const w of transcript.words) {
              if (seg.text.length) seg.text += " ";
              seg.text += w.text || w.word || "";
              seg.end = (w.end || w.to) / 1000;
              if (seg.end - blockTime > 5) {
                built.push({ ...seg });
                seg = {
                  start: (w.start || w.from) / 1000,
                  end: (w.end || w.to) / 1000,
                  text: w.text || w.word || "",
                };
                blockTime = seg.start;
              }
            }
            if (seg.text) built.push({ ...seg });
          } else if (transcript.text) {
            built.push({
              start: 0,
              end: Math.max(transcript.audio_duration || 1, 1),
              text: transcript.text,
            });
          }

          if (built.length) {
            toTranslateSegments = built;
            console.log(
              `[translate-subtitles] built ${built.length} segments from transcript ${transcriptId}`
            );
          } else {
            console.warn(
              "[translate-subtitles] transcript fetch returned no usable segments"
            );
          }
        } else {
          console.warn(
            "[translate-subtitles] no AssemblyAI API key; cannot fetch transcript by id"
          );
        }
      } catch (err) {
        console.warn(
          "[translate-subtitles] fetching transcript by id failed:",
          err && err.message ? err.message : err
        );
      }
    }

    // If srcLang is 'auto' or obviously incorrect (e.g., 'en' while script is Devanagari), try inferring from the first few segments
    if (
      (!srcLang || srcLang === "auto" || srcLang === "en") &&
      Array.isArray(toTranslateSegments) &&
      toTranslateSegments.length > 0
    ) {
      const votes = {};
      for (let i = 0; i < Math.min(8, toTranslateSegments.length); i++) {
        const s =
          toTranslateSegments[i] && toTranslateSegments[i].text
            ? toTranslateSegments[i].text
            : "";
        const guess = detectScriptFromTextSample(s);
        if (guess) votes[guess] = (votes[guess] || 0) + 1;
      }
      const winners = Object.keys(votes).sort((a, b) => votes[b] - votes[a]);
      if (winners.length > 0) {
        const inferred = winners[0];
        // choose inferred only if it has at least one vote and differs from current srcLang
        if (inferred && inferred !== srcLang) {
          console.log(
            `[translate-subtitles] inferred srcLang='${inferred}' from text script votes`,
            votes
          );
          srcLang = inferred;
        }
      }
    }

    srcLang = srcLang || "auto";
    console.log(
      `[translate-subtitles] using srcLang='${srcLang}' → tgtLang='${tgtLang}'`
    );

    if (
      !Array.isArray(toTranslateSegments) ||
      toTranslateSegments.length === 0
    ) {
      return res.status(400).json({
        ok: false,
        error: "No segments to translate (provide segments or transcriptId)",
      });
    }

    // If detected source and target are the same (and not 'auto'), skip translation to avoid MyMemory same-language error
    const simpleSrc = String(srcLang || "auto").toLowerCase();
    const simpleTgt = String(tgtLang || "auto").toLowerCase();
    if (simpleSrc !== "auto" && simpleSrc === simpleTgt) {
      console.log(
        "[translate-subtitles] src === tgt — skipping MyMemory; returning original segments and writing VTT"
      );

      const vttContentNoChange = buildVttFromSegments(toTranslateSegments);
      const filenameNoChange = `translated-${tgtLang}-${Date.now()}-${Math.floor(
        Math.random() * 10000
      )}.vtt`;
      const outPathNoChange = path.join(subtitlesDir, filenameNoChange);
      await fsPromises.writeFile(outPathNoChange, vttContentNoChange, "utf8");
      const vttUrlNoChange = `/subtitles/${filenameNoChange}?cb=${Date.now()}`;

      return res.json({
        ok: true,
        vttUrl: vttUrlNoChange,
        segments: toTranslateSegments,
      });
    }

    console.log(
      `[translate-subtitles] Translating ${toTranslateSegments.length} segments ${srcLang} → ${tgtLang}`
    );

    const translated = [];
    for (const seg of toTranslateSegments) {
      const original = seg.text || "";

      // Use MyMemory (primary)
      let translatedText = await translateWithMyMemory(
        original,
        srcLang || "auto",
        tgtLang
      );

      // If MyMemory returned the 'PLEASE SELECT TWO DISTINCT LANGUAGES' message or same as original in suspicious cases,
      // attempt a mirror fallback directly (translateTextWithFallback already called by translateWithMyMemory), but keep this here for safety.
      if (!translatedText || typeof translatedText !== "string") {
        translatedText = original;
      }

      translated.push({ ...seg, text: translatedText });

      // polite rate-limit to reduce chance of being rate-limited
      await new Promise((r) => setTimeout(r, 70));
    }

    // build & write translated VTT
    const vttContent = buildVttFromSegments(translated);
    if (!fs.existsSync(subtitlesDir))
      fs.mkdirSync(subtitlesDir, { recursive: true });

    const filename = `translated-${tgtLang}-${Date.now()}-${Math.floor(
      Math.random() * 10000
    )}.vtt`;
    const outPath = path.join(subtitlesDir, filename);
    await fsPromises.writeFile(outPath, vttContent, "utf8");

    const vttUrl = `/subtitles/${filename}?cb=${Date.now()}`;

    console.log("✅ Translated VTT saved:", outPath, "->", vttUrl);

    return res.json({ ok: true, vttUrl, segments: translated });
  } catch (err) {
    console.error(
      "❌ translate-subtitles error:",
      err && err.stack ? err.stack : err
    );
    return res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  }
});

// ============ VIDEO PROXY ============
app.get("/proxy/video", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl)
    return res.status(400).json({ error: "Missing 'url' parameter" });
  console.log("[proxy] Proxying video request...");

  try {
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "*/*",
    };
    if (req.headers.range) headers.Range = req.headers.range;

    const response = await axios.get(targetUrl, {
      responseType: "stream",
      timeout: 60000,
      maxRedirects: 10,
      headers,
      validateStatus: () => true,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

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
      console.error(
        "[proxy] Stream error:",
        err && err.message ? err.message : err
      );
      if (!res.headersSent)
        res.status(502).json({ error: "Failed to stream video" });
      else res.end();
    });

    req.on("abort", () => {
      console.log("[proxy] Client aborted");
      response.data.destroy();
    });
  } catch (err) {
    console.error("[proxy] Error:", err && err.message ? err.message : err);
    if (!res.headersSent)
      return res.status(502).json({
        error: "Proxy failed",
        details: err && err.message ? err.message : err,
      });
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
  console.log(`🌍 Translate: POST /translate-subtitles`);
  console.log(`📝 Subtitles: /subtitles/{filename}.vtt`);
  console.log(`🎥 Video proxy: GET /proxy/video?url={videoUrl}`);
});

module.exports = app;
