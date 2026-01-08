// transcribe.js
const fs = require("fs");
const path = require("path");

// Node fetch dynamic import (works in modern Node)
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

/** Convert seconds to VTT time */
function toVttTime(seconds) {
  const sec = Number(seconds) || 0;
  const ms = Math.floor(sec * 1000);

  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const milliseconds = ms % 1000;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0"
  )}:${String(secs).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

/** Build VTT content from segments */
function buildVtt(segments, fullText = "") {
  let vtt = "WEBVTT\n\n";

  if (!segments || segments.length === 0) {
    if (fullText) {
      vtt += `1\n00:00:00.000 --> 01:00:00.000\n${fullText}\n\n`;
    }
    return vtt;
  }

  segments.forEach((seg, idx) => {
    const start = toVttTime(seg.start);
    const end = toVttTime(seg.end);
    const text = seg.text || "";
    vtt += `${idx + 1}\n${start} --> ${end}\n${text}\n\n`;
  });

  return vtt;
}

/** Transcribe by uploading local bytes to AssemblyAI (existing flow) */
async function transcribeWithAssemblyAI(filePath) {
  const API_KEY = process.env.ASSEMBLYAI_API_KEY;
  if (!API_KEY) throw new Error("ASSEMBLYAI_API_KEY missing in .env");

  if (!fs.existsSync(filePath)) throw new Error("File not found: " + filePath);
  const stats = fs.statSync(filePath);
  if (stats.size === 0) throw new Error("Uploaded file is empty");

  // 1) upload raw bytes to AssemblyAI
  const readStream = fs.createReadStream(filePath);
  const uploadRes = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: {
      Authorization: API_KEY,
      "Content-Type": "application/octet-stream",
    },
    body: readStream,
  });
  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error("AssemblyAI upload failed: " + errText);
  }
  const uploadJson = await uploadRes.json();
  const upload_url = uploadJson.upload_url;

  // 2) create transcript job
  const transcriptRes = await fetch(
    "https://api.assemblyai.com/v2/transcript",
    {
      method: "POST",
      headers: {
        Authorization: API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        audio_url: upload_url,
      }),
    }
  );
  if (!transcriptRes.ok) {
    const errText = await transcriptRes.text();
    throw new Error("AssemblyAI transcript submit failed: " + errText);
  }
  const transcriptJson = await transcriptRes.json();
  const transcriptId = transcriptJson.id;

  // 3) poll until complete
  let result;
  while (true) {
    await new Promise((r) => setTimeout(r, 2500));
    const statusRes = await fetch(
      `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
      { method: "GET", headers: { Authorization: API_KEY } }
    );
    result = await statusRes.json();
    if (result.status === "completed") break;
    if (result.status === "error")
      throw new Error("AssemblyAI transcription failed: " + result.error);
  }

  // build segments (word-level -> blocks)
  let segments = [];
  if (Array.isArray(result.words) && result.words.length > 0) {
    let segment = { start: result.words[0].start / 1000, end: null, text: "" };
    let blockTime = segment.start;
    for (const w of result.words) {
      if (segment.text.length > 0) segment.text += " ";
      segment.text += w.text || w.word;
      segment.end = w.end / 1000;
      if (segment.end - blockTime > 5) {
        segments.push({ ...segment });
        segment = {
          start: w.start / 1000,
          end: w.end / 1000,
          text: w.text || w.word,
        };
        blockTime = segment.start;
      }
    }
    if (segment.text) segments.push({ ...segment });
  } else if (result.text) {
    segments = [
      {
        start: 0,
        end: Math.max(result.audio_duration || 0, 1),
        text: result.text,
      },
    ];
  }

  return {
    text: result.text,
    segments,
    raw: result,
  };
}

/** Transcribe by instructing AssemblyAI to fetch a remote audio URL */
async function transcribeWithAssemblyAIAudioUrl(audioUrl) {
  const API_KEY = process.env.ASSEMBLYAI_API_KEY;
  if (!API_KEY) throw new Error("ASSEMBLYAI_API_KEY missing in .env");
  if (!audioUrl) throw new Error("audioUrl required");

  const transcriptRes = await fetch(
    "https://api.assemblyai.com/v2/transcript",
    {
      method: "POST",
      headers: { Authorization: API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_url: audioUrl,
      }),
    }
  );
  if (!transcriptRes.ok) {
    const errText = await transcriptRes.text();
    throw new Error("AssemblyAI transcript submit failed: " + errText);
  }
  const transcriptJson = await transcriptRes.json();
  const transcriptId = transcriptJson.id;

  let result;
  while (true) {
    await new Promise((r) => setTimeout(r, 2500));
    const statusRes = await fetch(
      `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
      { method: "GET", headers: { Authorization: API_KEY } }
    );
    result = await statusRes.json();
    if (result.status === "completed") break;
    if (result.status === "error")
      throw new Error("AssemblyAI transcription failed: " + result.error);
  }

  let segments = [];
  if (Array.isArray(result.words) && result.words.length > 0) {
    let segment = { start: result.words[0].start / 1000, end: null, text: "" };
    let blockTime = segment.start;
    for (const w of result.words) {
      if (segment.text.length > 0) segment.text += " ";
      segment.text += w.text || w.word;
      segment.end = w.end / 1000;
      if (segment.end - blockTime > 5) {
        segments.push({ ...segment });
        segment = {
          start: w.start / 1000,
          end: w.end / 1000,
          text: w.text || w.word,
        };
        blockTime = segment.start;
      }
    }
    if (segment.text) segments.push({ ...segment });
  } else if (result.text) {
    segments = [
      {
        start: 0,
        end: Math.max(result.audio_duration || 0, 1),
        text: result.text,
      },
    ];
  }

  return {
    text: result.text,
    segments,
    raw: result,
  };
}

/**
 * Transcribe and save VTT. Accepts either filePath OR remoteUrl.
 * If remoteUrl is provided, AssemblyAI will fetch that URL directly.
 */
async function transcribeAndSaveVtt({
  filePath,
  remoteUrl,
  outDir = path.join(__dirname, "public", "subtitles"),
}) {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  let result;
  if (remoteUrl) {
    console.log("🛰️ transcribeAndSaveVtt: transcribing remote URL:", remoteUrl);
    result = await transcribeWithAssemblyAIAudioUrl(remoteUrl);
  } else {
    result = await transcribeWithAssemblyAI(filePath);
  }

  const { text, segments } = result;
  const baseFilename = remoteUrl
    ? `remote-${Date.now()}`
    : path.basename(filePath, path.extname(filePath));
  const vttFilename = `${baseFilename}-${Date.now()}.vtt`;
  const vttFilePath = path.join(outDir, vttFilename);
  const vttContent = buildVtt(segments, text || "");
  fs.writeFileSync(vttFilePath, vttContent, "utf8");

  console.log("📝 VTT file saved:", vttFilePath);

  return {
    text: text || "",
    segments: segments || [],
    vttPath: vttFilePath,
    vttFilename,
    vttUrlPath: `/subtitles/${vttFilename}`,
    raw: result.raw,
  };
}

module.exports = {
  transcribeWithAssemblyAI,
  transcribeWithAssemblyAIAudioUrl,
  transcribeAndSaveVtt,
  toVttTime,
  buildVtt,
};
