#!/usr/bin/env node
// Seeks the composition to specific times and screenshots it at 1920x1080.
//
//   node scripts/frames.mjs 0.5 3 7.25          # -> /tmp/glass-frames/t0003.000.jpg ...
//   FRAMES_URL=http://127.0.0.1:5199 node scripts/frames.mjs 12
//
// Uses the same seekForRender path the exporter uses, so a frame here is the
// frame the render will encode.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const url = `${process.env.FRAMES_URL ?? "http://127.0.0.1:5199"}/?EF_NONINTERACTIVE${process.env.FRAMES_QUERY ?? ""}`;
const outDir = process.env.FRAMES_OUT ?? "/tmp/glass-frames";
const times = process.argv.slice(2).map(Number);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on("console", (msg) => {
  if (["error", "warning"].includes(msg.type())) console.log(`[page ${msg.type()}]`, msg.text().slice(0, 600));
});
page.on("pageerror", (err) => console.log("[pageerror]", err.message.slice(0, 1200)));

await page.goto(url, { waitUntil: "load" });
await page.evaluate(async () => {
  await customElements.whenDefined("ef-timegroup");
  await document.fonts.ready;
  const root = document.querySelector("ef-timegroup#root");
  await root.resolveDuration?.();
  document.body.style.overflow = "hidden";
});
const duration = await page.evaluate(() => document.querySelector("ef-timegroup#root").duration);
console.log(`duration ${duration.toFixed(2)}s`);

for (const t of times) {
  const started = Date.now();
  await page.evaluate(async (time) => {
    const root = document.querySelector("ef-timegroup#root");
    await root.seekForRender(time, { strictVideoPaint: true });
  }, t);
  const file = `${outDir}/t${t.toFixed(3).padStart(8, "0")}.jpg`;
  await page.locator("ef-timegroup#root").screenshot({ path: file, type: "jpeg", quality: 88 });
  console.log(`${file} (${Date.now() - started}ms)`);
}
await browser.close();
