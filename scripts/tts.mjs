#!/usr/bin/env node
// Generates voiceover lines with Gemini TTS.
//
//   node scripts/tts.mjs                    # every line in vo-script.json
//   node scripts/tts.mjs hook-1 how-4       # only these ids
//   node scripts/tts.mjs --voice Kore --out /tmp/vo-audition hook-1 hook-2
//
// Writes loudness-normalized 48kHz WAVs to src/assets/vo/<id>.wav and
// records each clip's duration in src/vo-manifest.json.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = JSON.parse(readFileSync(path.join(root, "scripts/vo-script.json"), "utf8"));

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
};
const voice = flag("voice") ?? script.voice;
const model = flag("model") ?? script.model;
const outDir = flag("out") ?? path.join(root, "src/assets/vo");
const writeManifest = outDir === path.join(root, "src/assets/vo");
const only = new Set(args);

const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error("GEMINI_API_KEY is not set");

mkdirSync(outDir, { recursive: true });

// Gemini TTS speaks everything in a plain prompt; only this layout keeps the
// style notes out of the audio (system instructions are rejected by the model).
function buildPrompt(text) {
  const directed = [
    "# AUDIO PROFILE: Launch-film narrator",
    "## THE SCENE: A slick developer-tool launch video with music under the voice.",
    "### DIRECTOR'S NOTES",
    `Style: ${script.style}`,
    "#### TRANSCRIPT",
    text,
  ].join("\n");
  return { contents: [{ parts: [{ text: directed }] }] };
}

async function synthesize(text) {
  const body = {
    ...buildPrompt(text),
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
    const json = await res.json();
    const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (res.ok && part) return { pcm: Buffer.from(part.inlineData.data, "base64"), mime: part.inlineData.mimeType };
    console.warn(`  attempt ${attempt} failed:`, res.status, JSON.stringify(json.error ?? json).slice(0, 300));
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  throw new Error("TTS failed");
}

// Gemini TTS ends each clip with a short burst of noise after the speech has
// gone quiet. Walk back from the end past the burst to the first quiet 10ms
// window and cut there; silence trimming alone keeps it because it is loud.
function stripTailBurst(samples, rate) {
  const win = Math.round(rate * 0.01);
  const quiet = (i) => {
    let sum = 0;
    for (let k = i; k < i + win; k++) sum += samples[k] * samples[k];
    return Math.sqrt(sum / win) / 32768 < 0.003;
  };
  const limit = samples.length - Math.round(rate * 0.3);
  let i = samples.length - win;
  while (i > limit && !quiet(i)) i -= win;
  return i > limit ? samples.subarray(0, i) : samples;
}

// It also opens with a ~5ms click a few ms in, ahead of the leading silence.
// Cut through it to the quiet after it; if the first loud stretch isn't
// followed by 10ms of quiet it is speech, so leave it alone.
function stripHeadClick(samples, rate) {
  const win = Math.round(rate * 0.0025);
  const limit = Math.round(rate * 0.05);
  const quiet = (i) => {
    let sum = 0;
    for (let k = i; k < i + win; k++) sum += samples[k] * samples[k];
    return Math.sqrt(sum / win) / 32768 < 0.003;
  };
  let i = 0;
  while (i < limit && quiet(i)) i += win;
  if (i >= limit) return samples;
  while (i < limit && !quiet(i)) i += win;
  for (let k = 0; k < 4; k++) if (!quiet(i + k * win)) return samples;
  return samples.subarray(i);
}

function probeDuration(file) {
  return Number(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file])
      .toString()
      .trim(),
  );
}

const manifestPath = path.join(root, "src/vo-manifest.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};

for (const line of script.lines) {
  if (only.size && !only.has(line.id)) continue;
  console.log(`[${voice}] ${line.id}: ${line.text}`);
  const { pcm, mime } = await synthesize(line.text);
  const rate = Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000);
  const raw = path.join(outDir, `${line.id}.raw.pcm`);
  const wav = path.join(outDir, `${line.id}.wav`);
  const aligned = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.length & ~1));
  const samples = stripHeadClick(stripTailBurst(new Int16Array(aligned), rate), rate);
  writeFileSync(raw, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  // Trim leading/trailing silence, then normalize to a consistent narration level.
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "s16le", "-ar", String(rate), "-ac", "1", "-i", raw,
    "-af",
    [
      "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05",
      "areverse",
      "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08",
      "areverse",
      "loudnorm=I=-16:TP=-1.5:LRA=7",
    ].join(","),
    "-ar", "48000", "-ac", "1", wav,
  ]);
  rmSync(raw);
  const duration = probeDuration(wav);
  console.log(`  -> ${path.relative(root, wav)} (${duration.toFixed(2)}s)`);
  if (writeManifest) manifest[line.id] = { text: line.text, duration: Number(duration.toFixed(3)) };
}

if (writeManifest) {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`manifest -> ${path.relative(root, manifestPath)}`);
}
