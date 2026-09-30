#!/usr/bin/env node
// Screenshots test.html for shader look-dev.
//
//   node scripts/lookdev.mjs out.jpg "mode=EXTRUDE&img=hero&t=1" ["mode=RAIN&img=face" out2.jpg ...]

import { chromium } from "playwright";

const base = process.env.FRAMES_URL ?? "http://127.0.0.1:5199";
const args = process.argv.slice(2);
const browser = await chromium.launch({
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
page.on("console", (m) => m.type() === "error" && console.error("console:", m.text()));
// Vite may push a reload right after a source edit, aborting navigation.
async function open(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(url);
      await page.waitForFunction(() => typeof window.renderTest === "function");
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 700));
    }
  }
}

// The very first capture in a fresh browser comes back blank; burn one.
await open(`${base}/test.html?mode=RAIN&img=face&warmup=1`);
await page.evaluate(() => window.renderTest());
for (let i = 0; i < args.length; i += 2) {
  const [out, query] = [args[i], args[i + 1]];
  await open(`${base}/test.html?${query}`);
  await page.evaluate(() => document.fonts.ready);
  // The first draw after a cold shader compile can come back blank, so the
  // second (timed) draw is the one captured.
  const ms = await page.evaluate(async () => {
    await window.renderTest();
    const ms = await window.renderTest();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return ms;
  });
  await page.locator("#out").screenshot({ path: out, type: "jpeg", quality: 88 });
  console.log(`${out} (${ms.toFixed(0)}ms)`);
}
await browser.close();
