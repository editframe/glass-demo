#!/usr/bin/env node
// Builds the audible music bed: trimmed to the composition, ducked under the
// voiceover, faded out at the end. VO timings are read from index.html so the
// mix follows any retiming of scenes.
//
//   node scripts/mix.mjs              # -> src/assets/bed_mix.wav
//   node scripts/mix.mjs --normalize  # also loudness-normalizes src/assets/vo/*.wav in place

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, renameSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const assets = `${root}src/assets`;
const html = readFileSync(`${root}index.html`, "utf8");

if (process.argv.includes("--normalize")) {
  for (const file of readdirSync(`${assets}/vo`).filter((f) => f.endsWith(".wav"))) {
    const path = `${assets}/vo/${file}`;
    const measured = loudness(path);
    const gain = -16 - measured;
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", path, "-af", `volume=${gain.toFixed(2)}dB,alimiter=limit=0.75:level=false`, `${path}.tmp.wav`]);
    renameSync(`${path}.tmp.wav`, path);
    console.log(`${file}: ${measured.toFixed(1)} -> ${loudness(path).toFixed(1)} LUFS`);
  }
}

function loudness(path) {
  const out = execFileSync("sh", ["-c", `ffmpeg -hide_banner -i "${path}" -af ebur128 -f null - 2>&1`]).toString();
  return Number(out.match(/Integrated loudness:\s+I:\s+(-?[\d.]+)/)[1]);
}

// Scene starts in the #film sequence, then each scene's VO offsets.
const scenes = [...html.matchAll(/<ef-timegroup mode="fixed" duration="([\d.]+)s" data-scene="(\w+)"/g)].map((m) => ({
  duration: Number(m[1]),
  name: m[2],
  index: m.index,
}));
let start = 0;
const vo = [];
scenes.forEach((scene, i) => {
  const body = html.slice(scene.index, scenes[i + 1]?.index ?? html.length);
  for (const m of body.matchAll(/<ef-audio src="\/src\/assets\/vo\/([\w-]+)\.wav" offset="([\d.]+)"/g)) {
    vo.push({ id: m[1], at: start + Number(m[2]) });
  }
  start += scene.duration;
});
const total = start;
const bedIn = Number(html.match(/id="music" src="[^"]+" sourcein="([\d.]+)s"/)[1]);
console.log(`total ${total.toFixed(2)}s, ${vo.length} VO lines, bed from ${bedIn}s`);

const inputs = ["-ss", String(bedIn), "-t", String(total + 0.5), "-i", `${assets}/bed.mp3`];
for (const v of vo) inputs.push("-i", `${assets}/vo/${v.id}.wav`);
const delays = vo
  .map((v, i) => `[${i + 1}:a]aresample=48000,pan=stereo|c0=c0|c1=c0,adelay=${Math.round(v.at * 1000)}:all=1[v${i}]`)
  .join(";");
const stem = `${vo.map((_, i) => `[v${i}]`).join("")}amix=inputs=${vo.length}:normalize=0,apad=whole_dur=${total + 0.5}[vo]`;
// Bed sits ~10 dB under the voice, and dips another ~5 dB while it speaks.
const graph = [
  delays,
  stem,
  `[0:a]aresample=48000,volume=-14dB[bed]`,
  `[bed][vo]sidechaincompress=threshold=0.05:ratio=2.5:attack=30:release=450:makeup=1[ducked]`,
  `[ducked]afade=t=in:d=0.4,afade=t=out:st=${(total - 3.2).toFixed(2)}:d=3.0,atrim=0:${total.toFixed(3)}[out]`,
].join(";");
execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", graph, "-map", "[out]", "-ar", "48000", `${assets}/bed_mix.wav`], {
  stdio: "inherit",
});
console.log(`wrote bed_mix.wav (${loudness(`${assets}/bed_mix.wav`).toFixed(1)} LUFS)`);
