// transcribe.js
const fs = require("fs");
const path = require("path");
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

/** Transcribe by uploading local file to AssemblyAI */
async function transcribeWithAssemblyAI(filePath, languageCode = null) {
  const API_KEY = process.env.ASSEMBLYAI_API_KEY;
  if (!API_KEY) throw new Error("ASSEMBLYAI_API_KEY missing in .env");
  if (!fs.existsSync(filePath)) throw new Error("File not found: " + filePath);

  // Upload file to AssemblyAI
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

  // Create transcript job
  const transcriptBody = { audio_url: upload_url };
  
  if (languageCode && languageCode !== "auto") {
    transcriptBody.language_code = languageCode;
    console.log(`🌐 Using language: ${languageCode}`);
  } else {
    transcriptBody.language_detection = true;
    console.log(`🔍 Auto-detecting language...`);
  }

  const transcriptRes = await fetch(
    "https://api.assemblyai.com/v2/transcript",
    {
      method: "POST",
      headers: {
        Authorization: API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(transcriptBody),
    }
  );

  if (!transcriptRes.ok) {
    const errText = await transcriptRes.text();
    throw new Error("AssemblyAI transcript submit failed: " + errText);
  }

  const transcriptJson = await transcriptRes.json();
  const transcriptId = transcriptJson.id;

  // Poll until complete
  let result;
  while (true) {
    await new Promise((r) => setTimeout(r, 2500));
    const statusRes = await fetch(
      `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
      { method: "GET", headers: { Authorization: API_KEY } }
    );
    result = await statusRes.json();

    if (result.status === "completed") {
      console.log(`✅ Transcription completed. Language: ${result.language_code}`);
      break;
    }
    if (result.status === "error") {
      throw new Error("AssemblyAI transcription failed: " + result.error);
    }
  }

  // Build segments
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
    segments = [{
      start: 0,
      end: Math.max(result.audio_duration || 0, 1),
      text: result.text,
    }];
  }

  return {
    text: result.text,
    segments,
    transcriptId: transcriptId, // ✅ CRITICAL: Return transcriptId
    detectedLanguage: result.language_code,
    raw: result,
  };
}

/** Transcribe from remote URL */
async function transcribeWithAssemblyAIAudioUrl(audioUrl, languageCode = null) {
  const API_KEY = process.env.ASSEMBLYAI_API_KEY;
  if (!API_KEY) throw new Error("ASSEMBLYAI_API_KEY missing in .env");
  if (!audioUrl) throw new Error("audioUrl required");

  const transcriptBody = { audio_url: audioUrl };

  if (languageCode && languageCode !== "auto") {
    transcriptBody.language_code = languageCode;
  } else {
    transcriptBody.language_detection = true;
  }

  const transcriptRes = await fetch(
    "https://api.assemblyai.com/v2/transcript",
    {
      method: "POST",
      headers: { Authorization: API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(transcriptBody),
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
    if (result.status === "error") {
      throw new Error("AssemblyAI transcription failed: " + result.error);
    }
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
    segments = [{
      start: 0,
      end: Math.max(result.audio_duration || 0, 1),
      text: result.text,
    }];
  }

  return {
    text: result.text,
    segments,
    transcriptId: transcriptId,
    detectedLanguage: result.language_code,
    raw: result,
  };
}

/** Transcribe and save VTT */
async function transcribeAndSaveVtt({
  filePath,
  remoteUrl,
  outDir = path.join(__dirname, "public", "subtitles"),
  languageCode = null,
}) {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  let result;
  if (remoteUrl) {
    console.log("🛰️ Transcribing remote URL:", remoteUrl);
    result = await transcribeWithAssemblyAIAudioUrl(remoteUrl, languageCode);
  } else {
    result = await transcribeWithAssemblyAI(filePath, languageCode);
  }

  const { text, segments, transcriptId, detectedLanguage } = result;
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
    transcriptId, // ✅ CRITICAL: Return transcriptId
    detectedLanguage,
    raw: result.raw,
  };
}

/** Request translation from AssemblyAI */
/** Request translation from AssemblyAI - FIXED */
/** Request translation from AssemblyAI - FIXED */
async function requestAssemblyAITranslation(transcriptId, targetLang, opts = {}) {
  const API_KEY = process.env.ASSEMBLYAI_API_KEY;
  if (!API_KEY) throw new Error("ASSEMBLYAI_API_KEY missing in .env");
  if (!transcriptId || !targetLang) throw new Error("transcriptId and targetLang required");

  const target = String(targetLang);
  const deadlineMs = Date.now() + (opts.timeoutMs || 120000); // default 2 minutes
  const subtitlesDir = path.join(__dirname, "public", "subtitles");
  if (!fs.existsSync(subtitlesDir)) fs.mkdirSync(subtitlesDir, { recursive: true });

  console.log(`🌍 AssemblyAI translation requested for ${transcriptId} -> ${target}`);

  // 1) Submit the Speech Understanding translation request to llm-gateway
  const understandingUrl = "https://llm-gateway.assemblyai.com/v1/understanding";
  try {
    const body = {
      transcript_id: transcriptId,
      speech_understanding: {
        request: {
          translation: {
            target_languages: [target],
            // formal: true // optional
          }
        }
      }
    };

    const postRes = await fetch(understandingUrl, {
      method: "POST",
      headers: {
        Authorization: API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!postRes.ok) {
      const errText = await postRes.text();
      throw new Error("AssemblyAI understanding POST failed: " + errText);
    }

    const postJson = await postRes.json();
    // Post may return a job acknowledgement; translation results are observed on the transcript object.
    console.log("🌍 Translation request submitted (llm-gateway).", postJson?.id ? `id=${postJson.id}` : "");

  } catch (err) {
    console.error("❌ Failed to submit translation request:", err.message || err);
    throw err;
  }

  // 2) Poll the transcript for translation status
  let transcript = null;
  try {
    while (Date.now() < deadlineMs) {
      const r = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        method: "GET",
        headers: { Authorization: API_KEY },
      });

      if (!r.ok) {
        const errText = await r.text();
        throw new Error("Failed fetching transcript during translation: " + errText);
      }

      transcript = await r.json();

      // translation status available under speech_understanding.response.translation.status
      const transResp =
        transcript?.speech_understanding?.response?.translation?.status ||
        transcript?.speech_understanding?.response?.translation?.state;

      const hasTranslatedTexts = transcript?.translated_texts && transcript.translated_texts[target];

      if (transResp === "success" || hasTranslatedTexts) {
        console.log("✅ Translation completed on transcript.");
        break;
      }

      // not ready yet
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!transcript) throw new Error("No transcript received while polling.");

    const finalTransResp =
      transcript?.speech_understanding?.response?.translation?.status ||
      transcript?.speech_understanding?.response?.translation?.state;

    if (!(finalTransResp === "success" || (transcript.translated_texts && transcript.translated_texts[target]))) {
      // timed out or translation failed
      throw new Error("Translation did not complete within timeout or failed.");
    }

  } catch (err) {
    console.error("❌ Error while polling translation:", err.message || err);
    throw err;
  }

  // 3) Build translated segments from utterances (prefer per-utterance translated_texts)
  const segments = [];
  const utterances = transcript?.utterances || [];
  for (const u of utterances) {
    const startMs = Number(u.start || 0);
    const endMs = Number(u.end || 0);
    const start = startMs / 1000;
    const end = endMs / 1000;
    // per-utterance translations live in u.translated_texts[target]
    const text =
      (u?.translated_texts && (u.translated_texts[target] || u.translated_texts[target.toLowerCase()])) ||
      (transcript?.translated_texts && transcript.translated_texts[target]) ||
      u.text ||
      "";
    segments.push({ start, end, text });
  }

  // If utterances not present, fallback: return a single segment with full translated text
  if (segments.length === 0) {
    const fullTranslated = transcript?.translated_texts?.[target] || transcript?.text || "";
    segments.push({
      start: 0,
      end: Math.max((transcript?.audio_duration || 0) / 1000, 1),
      text: fullTranslated,
    });
  }

  // 4) Build VTT content and write file
  const vttLines = ["WEBVTT", ""];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const toVttTime = (sec) => {
      const totalMs = Math.round((sec || 0) * 1000);
      const ms = totalMs % 1000;
      let sleft = Math.floor(totalMs / 1000);
      const secs = sleft % 60;
      sleft = Math.floor(sleft / 60);
      const mins = sleft % 60;
      const hrs = Math.floor(sleft / 60);
      const pad = (n, z = 2) => String(n).padStart(z, "0");
      return `${pad(hrs)}:${pad(mins)}:${pad(secs)}.${String(ms).padStart(3, "0")}`;
    };

    vttLines.push(String(i + 1));
    vttLines.push(`${toVttTime(s.start)} --> ${toVttTime(s.end)}`);
    vttLines.push((s.text || "").replace(/\r\n/g, "\n"));
    vttLines.push("");
  }
  const finalVtt = vttLines.join("\n");
  const filename = `${transcriptId}-${target}-${Date.now()}.vtt`;
  const outPath = path.join(subtitlesDir, filename);
  fs.writeFileSync(outPath, finalVtt, "utf8");
  console.log("📝 Translated VTT written:", outPath);

  return {
    vttFilename: filename,
    vttUrlPath: `/subtitles/${encodeURIComponent(filename)}`,
    segments,
    translatedText: transcript?.translated_texts?.[target] || null,
  };
}

module.exports = {
  transcribeWithAssemblyAI,
  transcribeWithAssemblyAIAudioUrl,
  transcribeAndSaveVtt,
  requestAssemblyAITranslation,
  toVttTime,
  buildVtt,
};
