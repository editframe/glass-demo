#!/usr/bin/env node
// Uses Gemini audio understanding as a stand-in for listening to TTS output.
//
//   node scripts/vo-check.mjs src/assets/vo/*.wav
//
// Prints an exact transcript plus notes on pacing, artifacts, and delivery.

import { readFileSync } from "node:fs";
import path from "node:path";

const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error("GEMINI_API_KEY is not set");
const model = process.env.VO_CHECK_MODEL ?? "gemini-2.5-flash";

const prompt = `You are a meticulous audio QA engineer reviewing a voiceover clip for a product video.
Return JSON with keys:
  "transcript": exact verbatim words spoken (no corrections),
  "extra_speech": true if anything other than a single short narration line is spoken (e.g. instructions read aloud),
  "artifacts": list any glitches, clicks, robotic warble, cut-off words, long silences, mispronunciations,
  "delivery": one sentence on tone and pacing,
  "score": 1-10 overall quality as professional narration.`;

for (const file of process.argv.slice(2)) {
  const data = readFileSync(file).toString("base64");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: "audio/wav", data } }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    },
  );
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? JSON.stringify(json.error ?? json);
  console.log(`\n== ${path.relative(process.cwd(), file)}\n${text}`);
}
