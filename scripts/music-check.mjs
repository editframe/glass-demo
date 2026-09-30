#!/usr/bin/env node
// Rates candidate music beds with Gemini audio understanding.
//
//   node scripts/music-check.mjs /tmp/music/*.mp3

import { execFileSync } from "node:child_process";
import path from "node:path";

const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error("GEMINI_API_KEY is not set");
const model = process.env.VO_CHECK_MODEL ?? "gemini-3.8-flash";

const prompt = `You are a music supervisor choosing a bed for a 90-second product launch film.
The film shows sleek real-time glass / refraction shader effects over footage of people (dancers, singers, portraits),
with a confident, calm male voiceover on top the whole time. It should feel premium, modern, cool (Apple keynote / design-tool launch),
not cheesy corporate, not aggressive, no vocals.
Listen to the whole clip and return JSON with keys:
  "vocals": true if there are sung or spoken vocals or vocal chops anywhere,
  "bpm": your best estimate,
  "mood": short phrase,
  "arc": list of {"t": seconds, "event": short description} for intro, builds, drops, breakdowns, and the ending,
  "under_vo": 1-10 how well it sits under narration (sparse mids, steady energy),
  "premium": 1-10 how premium/modern/cool it feels for this film,
  "notes": one sentence.`;

async function check(file) {
  const data = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-t", "150", "-ac", "1", "-b:a", "48k", "-f", "mp3", "-"], {
    maxBuffer: 64 << 20,
  }).toString("base64");
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: "audio/mp3", data } }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  const json = await res.json();
  return json.candidates?.[0]?.content?.parts?.[0]?.text ?? JSON.stringify(json.error ?? json);
}

const results = await Promise.all(process.argv.slice(2).map(async (f) => [f, await check(f)]));
for (const [file, text] of results) console.log(`\n== ${path.basename(file)}\n${text}`);
