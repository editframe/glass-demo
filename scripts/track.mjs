#!/usr/bin/env node
// Tracks a point on a subject through a clip with Gemini pointing, so glass
// can follow it. Writes src/tracks/<name>.json: [{ t, x, y }] in 1920x1080 px.
//
//   node scripts/track.mjs src/assets/singer.mp4 singer 8 13.2 0.2 "the singer's mouth"

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const [file, name, from, to, step, subject = "the person's face"] = process.argv.slice(2);
const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error("GEMINI_API_KEY is not set");
const model = process.env.TRACK_MODEL ?? "gemini-3.8-flash";

function frameAt(t) {
  return execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=960:540", "-f", "mjpeg", "-"], {
    maxBuffer: 16 << 20,
  }).toString("base64");
}

async function detect(t) {
  const prompt = `Point to ${subject}. Return JSON {"point": [y, x]} normalized to 0-1000. If not visible return {"point": null}.`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ inlineData: { mimeType: "image/jpeg", data: frameAt(t) } }, { text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
    });
    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
    try {
      const parsed = JSON.parse(text);
      const point = (Array.isArray(parsed) ? parsed[0] : parsed)?.point;
      if (!point) return { t, x: null, y: null };
      return { t, x: point[1] * 1.92, y: point[0] * 1.08 };
    } catch {
      console.error(`t=${t} attempt ${attempt}:`, (text ?? JSON.stringify(json.error ?? json)).slice(0, 200));
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return { t, box: null };
}

const times = [];
for (let t = Number(from); t <= Number(to) + 1e-6; t += Number(step)) times.push(Number(t.toFixed(3)));
const results = [];
for (let i = 0; i < times.length; i += 4) results.push(...(await Promise.all(times.slice(i, i + 4).map(detect))));
mkdirSync("src/tracks", { recursive: true });
writeFileSync(`src/tracks/${name}.json`, JSON.stringify(results, null, 1));
for (const r of results) console.log(r.t, r.x?.toFixed(0), r.y?.toFixed(0));
