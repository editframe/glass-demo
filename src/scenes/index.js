import { glassScene, range, ease, lerp, track, clamp, hash, rootTime, compRect } from "../glass/scene.js";
import { GlassRenderer, MODE, placePlane, placeSolid } from "../glass/renderer.js";
import { textSdf } from "../glass/sdf.js";
import singerTrack from "../tracks/singer.json";

const ANTON = { family: "Anton", weight: 400 };
const INTER_BLACK = { family: "Inter Tight", weight: 900 };
const FPS = 30;

// Extruded glass is lit by the distance field's gradient, and a 1x field
// stripes the walls, so solid type is built at 2x.
const solidText = (opts) => textSdf({ scale: 2, ...opts });
const GLASS_WORD = { lines: ["GLASS"], font: ANTON, size: 560, tracking: 10, italic: true };

/** The chunky frosted look shared by every extruded word. */
const FROSTED = { uDepth: 70, uRound: 18, uMilk: 0.8, uFrost: 0.4, uShadow: 0.4 };

/** Places a text SDF's plane in 3D and returns the matching SDF uniforms. */
function planeUniforms(sdf, placement) {
  const plane = placePlane({ planeWidth: sdf.planeWidth, planeHeight: sdf.planeHeight, ...placement });
  return { uInvH: plane.invH, uPlaneScale: plane.planeScale };
}

/** Sweep a specular band across the frame between t0 and t1. */
const sweep = (t, t0, t1) => lerp(-0.25, 1.7, range(t, t0, t1, ease.inOutSine));

/** Average of FFT bins [a, b) normalized to 0..1. */
function band(fft, a, b) {
  if (!fft) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += fft[i] ?? 0;
  return sum / ((b - a) * 255);
}

async function loadImage(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

/** Position on a point track at source time `s`, smoothed over ±0.3s to take out jitter. */
function follow(points, s) {
  const at = (u) => {
    if (u <= points[0].t) return points[0];
    for (let i = 1; i < points.length; i++) {
      const b = points[i];
      if (u > b.t) continue;
      const a = points[i - 1];
      const k = (u - a.t) / (b.t - a.t);
      return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) };
    }
    return points[points.length - 1];
  };
  const taps = [
    [-0.3, 1],
    [-0.15, 2],
    [0, 3],
    [0.15, 2],
    [0.3, 1],
  ];
  let x = 0;
  let y = 0;
  for (const [dt, w] of taps) {
    const p = at(s + dt);
    x += p.x * w;
    y += p.y * w;
  }
  return [x / 9, y / 9];
}

export const scenes = {
  // ------------------------------------------------------------------ PART 1
  hook(tg) {
    const liveAt = Number(tg.dataset.liveAt);
    glassScene(tg, {
      async setup({ renderer }) {
        const [sdf, still] = await Promise.all([solidText(GLASS_WORD), loadImage(tg.dataset.still)]);
        renderer.setSdf(sdf);
        return { still };
      },
      frame({ state }, { ownCurrentTime: t }) {
        const k = ease.inOutSine(t / 9);
        return {
          mode: MODE.EXTRUDE,
          // Hold the first frame until the voiceover says "live video".
          source: t < liveAt ? state.still : undefined,
          uniforms: {
            uTime: t,
            ...placeSolid({
              y: lerp(725, 700, k),
              rotateY: lerp(-16, 12, k),
              rotateX: lerp(11, -3, k),
              rotateZ: -3,
              scale: lerp(0.94, 1.02, k),
            }),
            ...FROSTED,
            uReveal: range(t, 0.25, 2.0, ease.outCubic) * (1 - range(t, 8.35, 8.95, ease.inCubic)),
            uSweep: t < 4 ? sweep(t, 1.5, 3.1) : sweep(t, 5.4, 7.2),
            uBgDim: 1 - range(t, 0, 0.6, ease.outCubic),
          },
        };
      },
    });
  },

  outline(tg) {
    const cards = [
      { c: [420, 525], at: 0.62 },
      { c: [960, 525], at: 2.08 },
      { c: [1500, 525], at: 3.3 },
    ];
    glassScene(tg, {
      frame(_ctx, { ownCurrentTime: t }) {
        const rects = [];
        const looks = [];
        for (const card of cards) {
          const e = clamp((t - card.at + 0.05) / 0.75);
          if (e <= 0) continue;
          const s = ease.outBack(e, 1.2);
          rects.push([card.c[0], card.c[1] + (1 - s) * 30, 250 * s, 165 * s]);
          looks.push([40 * Math.min(1, s), 3.4, 24, 1]);
        }
        return {
          mode: MODE.PANELS,
          uniforms: {
            uTime: t,
            uRects: rects.length ? rects : [[0, 0, 0, 0]],
            uRectLook: looks.length ? looks : [[0, 0, 1, 0]],
            uRectCount: rects.length,
            uBgBlur: 2.2,
            uBgDim: 0.3,
            uRefract: 55,
            uDispersion: 0.45,
            uSweep: sweep(t, 3.2, 4.8),
            uTint: [0.66, 0.68, 0.74],
            uTintAmt: 1,
          },
        };
      },
    });
  },

  // ------------------------------------------------------------------ PART 2
  chunky(tg) {
    glassScene(tg, {
      async setup({ renderer }) {
        renderer.setSdf(await solidText({ lines: ["DEPTH"], font: ANTON, size: 520, tracking: 12, italic: true }));
      },
      frame(_ctx, { ownCurrentTime: t }) {
        const k = ease.inOutSine(t / 4.46);
        return {
          mode: MODE.EXTRUDE,
          uniforms: {
            uTime: t,
            ...placeSolid({
              y: 700,
              rotateY: lerp(30, -22, k),
              rotateX: lerp(14, 4, k),
              rotateZ: -3,
              scale: lerp(0.92, 1.0, k),
            }),
            ...FROSTED,
            // The slab thickens as the voiceover says "real depth".
            uDepth: track(t, [
              [0, 40],
              [1.4, 40],
              [2.8, 105],
            ]),
            uRound: 22,
            uMilk: 1.0,
            uFrost: 0.8,
            uShadow: 0.3,
            uReveal: range(t, 0.0, 0.8, ease.outCubic),
            uSweep: sweep(t, 2.4, 4.0),
          },
        };
      },
    });
  },

  lens(tg) {
    const offset = Number(tg.dataset.trackOffset);
    glassScene(tg, {
      frame(_ctx, { ownCurrentTime: t }) {
        // The track follows her mouth; the lens sits on the middle of her face.
        const [mx, my] = follow(singerTrack, offset + t);
        const cx = mx + 25;
        const cy = my - 65;
        const grow = ease.outBack(clamp((t - 0.05) / 0.7), 1.3) * (1 - range(t, 4.0, 4.46, ease.inCubic));
        const r = 215 * grow;
        // Two satellites drift in and out of the smooth-min blend.
        const a = t * 1.6;
        const gap = 300 + Math.sin(t * 2.3) * 50;
        const blobs = [
          [cx, cy, r, 0],
          [cx + Math.cos(a) * gap, cy + Math.sin(a) * gap * 0.8, 46 * grow, 0],
          [cx + Math.cos(a + 2.6) * (gap + 40), cy + Math.sin(a + 2.6) * (gap + 40) * 0.8, 32 * grow, 0],
        ].filter((b) => b[2] > 0.5);
        return {
          mode: MODE.BLOBS,
          uniforms: {
            uTime: t,
            uBlobs: blobs.length ? blobs : [[0, 0, 0, 0]],
            uBlobCount: blobs.length,
            uBlend: 80,
            uBevel: 200,
            uProfile: 1.0,
            uRefract: 90,
            uDispersion: 0.7,
            uSweep: sweep(t, 0.8, 2.6),
            uShadow: 0.25,
          },
        };
      },
    });
  },

  reeded(tg) {
    glassScene(tg, {
      frame(_ctx, { ownCurrentTime: t }) {
        const enter = range(t, 0.15, 1.35, ease.outExpo);
        const cx = lerp(2560, 1060, enter) - t * 22;
        return {
          mode: MODE.REEDED,
          uniforms: {
            uTime: t,
            uPanel: [cx, 560, 540, 400],
            uPanelRadius: 34,
            uRibWidth: 46,
            uRibDepth: 1.1,
            uRefract: 70,
            uDispersion: 0.55,
            uFrost: 0.4,
            uSweep: sweep(t, 1.2, 3.2),
            uShadow: 0.4,
          },
        };
      },
    });
  },

  frosted(tg) {
    const bars = 12;
    glassScene(tg, {
      async frame({ music }, { ownCurrentTime: t }) {
        const fft = music ? await music.getFrequencyData(rootTime(tg)) : null;
        const intro = range(t, 0.3, 1.0, ease.outBack);
        const rects = [[490, 510, 380 * intro, 150 * intro]];
        const looks = [[44 * Math.min(1, intro), 3.6, 24, 1]];
        const n = fft?.length ?? 128;
        for (let i = 0; i < bars; i++) {
          const a = Math.floor(Math.pow(i / bars, 1.8) * n * 0.55) + 1;
          const b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / bars, 1.8) * n * 0.55) + 1);
          const level = band(fft, a, b);
          const appear = range(t, 0.45 + i * 0.04, 0.9 + i * 0.04, ease.outCubic);
          const h = (60 + Math.pow(level, 1.4) * 520) * appear;
          const x = 1110 + i * 58;
          rects.push([x, 800 - h / 2, 20, Math.max(0.1, h / 2)]);
          looks.push([20, 1.0, 16, 1.4]);
        }
        const bass = band(fft, 1, 5);
        return {
          mode: MODE.PANELS,
          uniforms: {
            uTime: t,
            uRects: rects,
            uRectLook: looks,
            uRectCount: rects.length,
            uRefract: 60,
            uDispersion: 0.5,
            uFrost: 0,
            uBgDim: 0.1,
            uSweep: sweep(t, 1.4, 3.2),
            uSpecular: 0.9 + bass * 0.8,
            uBass: bass,
          },
        };
      },
    });
  },

  water(tg) {
    const bpm = Number(tg.dataset.bpm ?? 120);
    const beat = 60 / bpm;
    const beatOffset = Number(tg.dataset.beatOffset ?? 0);
    const levels = new Map();
    glassScene(tg, {
      async frame({ music }, { ownCurrentTime: t }) {
        const t0 = rootTime(tg) - t;
        const ripples = [];
        // Ripples spawn on the beat grid; each one's strength is the bass
        // level sampled at its spawn time, so re-seeking replays them exactly.
        const first = Math.ceil((t0 + 0.15 - beatOffset) / beat);
        for (let b = first; ; b++) {
          const at = beatOffset + b * beat - t0;
          if (at > t) break;
          if (t - at > 3.2) continue;
          if (!levels.has(b)) {
            const fft = music ? await music.getFrequencyData(t0 + at) : null;
            levels.set(b, band(fft, 1, 5));
          }
          const level = levels.get(b);
          ripples.push([280 + hash(b) * 1360, 200 + hash(b + 71) * 680, at, 10 + level * 26]);
        }
        const fft = music ? await music.getFrequencyData(rootTime(tg)) : null;
        return {
          mode: MODE.WATER,
          uniforms: {
            uTime: t,
            uRipples: ripples.length ? ripples.slice(-16) : [[0, 0, 999, 0]],
            uRippleCount: Math.min(16, ripples.length),
            uWaveSpeed: 560,
            uAmbient: 3.2,
            uRefract: 3.2,
            uDispersion: 0.35,
            uSpecular: 0.9,
            uLightDir: [-0.4, -0.7, 0.5],
            uSweep: -1,
            uBass: band(fft, 1, 5),
          },
        };
      },
    });
  },

  rain(tg) {
    const impact = Number(tg.dataset.impact);
    const next = tg.querySelector('[data-plate="next"] ef-surface');
    const rain = (t) => ({ uTime: t, uRain: lerp(0.55, 1, range(t, 0, 2.6, ease.inOutSine)), uFog: 0.86, uLens: 4 });
    glassScene(tg, {
      surface: '[data-plate="rain"] ef-surface',
      async setup() {
        const frozen = document.createElement("canvas");
        return { still: await loadImage(tg.dataset.still), frozen, pane: new GlassRenderer(frozen), paneReady: false };
      },
      frame({ state }, { ownCurrentTime: t }) {
        if (t < impact) return { mode: MODE.RAIN, uniforms: rain(t) };
        // At the impact the pane (drops and all) freezes into a still, and
        // that still is what breaks. The next shot plays underneath.
        if (!state.paneReady) {
          state.pane.render(state.still, MODE.RAIN, rain(impact));
          state.paneReady = true;
        }
        return {
          mode: MODE.SHATTER,
          source: next.getDisplayCanvas(),
          uniforms: { uTime: t, source2: state.frozen, uShatter: t - impact, uImpact: [1090, 540], uCell: 180 },
        };
      },
    });
  },

  // ------------------------------------------------------------------ PART 3
  layers(tg) {
    const layers = [...tg.querySelectorAll(".layer")];
    const corners = layers.map((layer) => layer.querySelector(".corner"));
    const labels = [...tg.querySelectorAll(".layer-label")];
    const labelTag = labels[0].querySelector("b");
    const labelDetail = labels[0].querySelector("i");
    glassScene(tg, {
      surface: '.layer[data-layer="1"] ef-surface',
      canvas: '.layer[data-layer="2"] canvas',
      async setup({ renderer }) {
        renderer.setSdf(await solidText(GLASS_WORD));
      },
      frame(_ctx, { ownCurrentTime: t }) {
        const e = range(t, 1.0, 3.3, ease.inOutCubic) * (1 - range(t, 20.7, 22.2, ease.inOutCubic));
        const active = t < 3.8 ? -1 : t < 8.5 ? 0 : t < 14.6 ? 1 : t < 20.6 ? 2 : -1;

        layers.forEach((layer, i) => {
          const z = (i - 1) * 600 * e;
          layer.style.transform =
            `translate3d(${-520 * e}px, ${10 * e}px, 0) scale(${1 - 0.65 * e}) ` +
            `rotateX(${57 * e}deg) rotateZ(${-37 * e}deg) translateZ(${z}px)`;
          const dim = active === -1 || active === i ? 1 : 0.32;
          layer.style.opacity = String(lerp(1, dim, e));
          layer.style.setProperty("--outline", String(active === i ? 0.9 * e : 0.18 * e));
        });
        layers[1].style.setProperty("--grid", String(active === 1 ? 0.9 * e : 0.35 * e));

        // Matches the .any-html fade in CSS.
        const html = t >= 6.65 && t < 8.4;
        labelTag.textContent = html ? '<div class="card">' : "<ef-video>";
        labelDetail.textContent = html ? "any HTML works" : "decoded once";

        // Each label hangs off its layer's far corner, wherever the 3D transform puts it.
        labels.forEach((label, i) => {
          const r = compRect(corners[i], tg);
          label.style.left = `${r.left + 26}px`;
          label.style.top = `${r.top - 34}px`;
          label.style.opacity = String(range(t, 2.6 + i * 0.25, 3.2 + i * 0.25) * (1 - range(t, 20.4, 20.9)));
          label.classList.toggle("active", active === i);
        });

        return {
          mode: MODE.EXTRUDE,
          uniforms: {
            uTime: t,
            ...placeSolid({ y: 560, rotateY: Math.sin(t * 0.35) * 10, rotateX: 6, rotateZ: -3 }),
            ...FROSTED,
            uGlassOnly: 1,
            uShadow: 0,
            uSweep: sweep(t % 7, 1, 3),
          },
        };
      },
    });
  },

  prism(tg) {
    const line = tg.querySelector(".split-line");
    const [tagLeft, tagRight] = line.querySelectorAll(".split-tag");
    glassScene(tg, {
      async setup({ renderer }) {
        const [sdf, still] = await Promise.all([
          textSdf({ lines: ["PRISM"], font: ANTON, size: 490, tracking: 12, y: 420 }),
          loadImage(tg.dataset.still),
        ]);
        renderer.setSdf(sdf);
        return { sdf, still };
      },
      frame({ state }, { ownCurrentTime: t }) {
        const split = lerp(-20, 1940, range(t, 0.8, 3.7, ease.inOutCubic));
        line.style.setProperty("--split-x", `${split}px`);
        line.style.opacity = String(range(t, 0.5, 0.8) * (1 - range(t, 3.7, 4.1)));
        tagLeft.style.opacity = String(range(split, 180, 320));
        tagRight.style.opacity = String(1 - range(split, 1640, 1780));
        return {
          mode: MODE.SDF,
          source: state.still,
          uniforms: {
            uTime: t,
            ...planeUniforms(state.sdf, {
              rotateY: lerp(-7, 7, ease.inOutSine(t / 6.4)),
              rotateX: 5,
              scale: lerp(0.98, 1.04, t / 6.4),
            }),
            uReveal: 1,
            uSplit: split,
            uDispersion: 0,
            uDispersion2: 1.25,
            uRefract: 110,
            uBevel: 52,
            uSweep: sweep(t, 4.0, 5.8),
          },
        };
      },
    });
  },

  clock(tg) {
    const fill = tg.querySelector(".preview");
    const read = tg.querySelector("[data-seek]");
    const readFrame = tg.querySelector("[data-seek-frame]");
    const ghosts = tg.querySelector(".scrub-ghosts");
    const SPAN = 5;
    const visits = [1.0, 3.4];
    ghosts.innerHTML = visits.map((v) => `<i style="left:${(v / SPAN) * 100}%"></i>`).join("");
    glassScene(tg, {
      async setup({ renderer }) {
        const [sdf, still] = await Promise.all([
          solidText({ lines: ["FRAME"], font: ANTON, size: 540, tracking: 10, italic: true }),
          loadImage(tg.dataset.still),
        ]);
        renderer.setSdf(sdf);
        return { still };
      },
      frame({ state }, { ownCurrentTime: t }) {
        // Scrub like an editor would: play, jump ahead, jump back, resume.
        const s = track(t, [
          [0.9, 0],
          [1.9, 1.0, ease.linear],
          [2.2, 3.4, ease.inOutExpo],
          [3.3, 3.4],
          [3.6, 1.0, ease.inOutExpo],
          [4.5, 1.0],
          [4.8, 2.4, ease.inOutExpo],
          [6.8, 4.4, ease.linear],
        ]);
        fill.style.setProperty("--seek-pct", `${(s / SPAN) * 100}%`);
        ghosts.style.opacity = String(range(t, 3.6, 4.0));
        read.textContent = `${s.toFixed(2)}s`;
        readFrame.textContent = String(Math.round(s * FPS)).padStart(3, "0");
        return {
          mode: MODE.EXTRUDE,
          source: state.still,
          uniforms: {
            uTime: s,
            ...placeSolid({ y: 560, rotateY: Math.sin(s * 0.8) * 14, rotateX: 6, rotateZ: -3, scale: 0.96 }),
            ...FROSTED,
            uReveal: ease.outCubic(s / 1.2),
            uSweep: s * 0.5 - 0.3,
          },
        };
      },
    });
  },

  scale(tg) {
    const slices = [...tg.querySelectorAll(".slice")];
    glassScene(tg, {
      async setup({ renderer }) {
        renderer.setSdf(await solidText(GLASS_WORD));
      },
      frame(_ctx, { ownCurrentTime: t }) {
        slices.forEach((slice, i) => {
          const dur = 1.55 + 0.35 * hash(i + 3);
          slice.style.setProperty("--p", String(range(t, 4.9 + i * 0.07, 4.9 + i * 0.07 + dur, ease.inOutSine)));
        });
        return {
          mode: MODE.EXTRUDE,
          uniforms: {
            uTime: t,
            ...placeSolid({ y: 600, rotateY: Math.sin(t * 0.9) * 16, rotateX: 8, rotateZ: -3, scale: 0.92 }),
            ...FROSTED,
            uSweep: sweep(t % 3, 0.5, 2.2),
          },
        };
      },
    });
  },

  outro(tg) {
    glassScene(tg, {
      async setup({ renderer }) {
        renderer.setSdf(await solidText({ lines: ["editframe"], font: INTER_BLACK, size: 330, tracking: -12 }));
      },
      frame(_ctx, { ownCurrentTime: t }) {
        const k = ease.inOutSine(t / 6.2);
        return {
          mode: MODE.EXTRUDE,
          uniforms: {
            uTime: t,
            ...placeSolid({
              y: 470,
              rotateY: lerp(-12, 10, k),
              rotateX: lerp(10, -2, k),
              scale: lerp(0.95, 1.02, k),
            }),
            ...FROSTED,
            uDepth: 50,
            uRound: 14,
            uReveal: range(t, 0.2, 1.4, ease.outCubic),
            uSweep: sweep(t, 1.6, 3.4),
            uBgDim: range(t, 2.0, 4.0) * 0.25,
          },
        };
      },
    });
  },
};
