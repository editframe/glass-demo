import { GlassRenderer } from "./renderer.js";

/**
 * Wires a scene timegroup to a glass renderer.
 *
 *   <ef-timegroup class="glass-scene">
 *     <ef-timegroup mode="fit" class="plate">
 *       <ef-video id="city" src="city.mp4"></ef-video>
 *       <ef-surface target="city"></ef-surface>   <- pixels the glass bends
 *     </ef-timegroup>
 *     <canvas class="glass-canvas"></canvas>       <- WebGL output
 *   </ef-timegroup>
 *
 * The plate lives in its own timegroup so the ef-surface has already
 * mirrored the current frame by the time this scene's frame task runs.
 *
 * `setup(ctx)` runs once (async, e.g. to build SDFs); `frame(ctx, info)`
 * returns `{ mode, uniforms }` for each frame. Everything is derived from
 * `info.ownCurrentTime`, so seeks and exports reproduce the same pixels.
 */
export function glassScene(timegroup, { setup, frame, canvas = ".glass-canvas", surface = ".plate ef-surface" }) {
  let ready = null;
  timegroup.addFrameTask(async (info) => {
    ready ??= (async () => {
      const ctx = {
        timegroup,
        renderer: new GlassRenderer(timegroup.querySelector(canvas)),
        surface: timegroup.querySelector(surface),
        music: findInRoot(timegroup, "#music"),
      };
      ctx.state = setup ? await setup(ctx) : {};
      return ctx;
    })();
    const ctx = await ready;
    const { mode, uniforms, source } = await frame(ctx, info);
    ctx.renderer.render(source ?? ctx.surface.getDisplayCanvas(), mode, uniforms);
    // Live uniform readouts: <span data-param="uDispersion" data-digits="2">
    for (const el of timegroup.querySelectorAll("[data-param]")) {
      const v = uniforms[el.dataset.param];
      if (typeof v === "number") el.textContent = v.toFixed(Number(el.dataset.digits ?? 2));
    }
  });
}

function rootOf(el) {
  let root = el;
  while (root.parentElement?.closest("ef-timegroup")) root = root.parentElement.closest("ef-timegroup");
  return root;
}

/** Looks up an element inside this composition (the live tree or an export clone). */
export function findInRoot(el, selector) {
  return rootOf(el).querySelector(selector);
}

/** Composition-level time, e.g. for sampling the music bed's FFT. */
export function rootTime(el) {
  return rootOf(el).currentTime ?? 0;
}

/** Position of `el` in composition pixels, independent of preview zoom. */
export function compRect(el, reference) {
  const root = rootOf(reference ?? el);
  const r = root.getBoundingClientRect();
  const s = r.width / (root.offsetWidth || 1920);
  const b = el.getBoundingClientRect();
  return {
    left: (b.left - r.left) / s,
    top: (b.top - r.top) / s,
    right: (b.right - r.left) / s,
    bottom: (b.bottom - r.top) / s,
    width: b.width / s,
    height: b.height / s,
  };
}

// Easing + keyframe helpers shared by scenes.
export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const ease = {
  linear: (t) => clamp(t),
  outCubic: (t) => 1 - Math.pow(1 - clamp(t), 3),
  inCubic: (t) => Math.pow(clamp(t), 3),
  inOutCubic: (t) => {
    t = clamp(t);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  },
  outExpo: (t) => (clamp(t) === 1 ? 1 : 1 - Math.pow(2, -10 * clamp(t))),
  inOutExpo: (t) => {
    t = clamp(t);
    if (t === 0 || t === 1) return t;
    return t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2;
  },
  inOutSine: (t) => -(Math.cos(Math.PI * clamp(t)) - 1) / 2,
  outBack: (t, s = 1.5) => {
    t = clamp(t) - 1;
    return t * t * ((s + 1) * t + s) + 1;
  },
};
/** Eased progress of `t` through [a, b]. */
export const range = (t, a, b, fn = ease.inOutCubic) => fn(clamp((t - a) / (b - a)));

/**
 * Piecewise keyframes: track(t, [[0, 10], [1.2, 40, ease.outCubic], [3, 20]])
 * The easing on a key applies to the segment that ends at that key.
 */
export function track(t, keys) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1, fn = ease.inOutCubic] = keys[i];
    const [t0, v0] = keys[i - 1];
    if (t <= t1) return lerp(v0, v1, fn((t - t0) / (t1 - t0)));
  }
  return keys[keys.length - 1][1];
}

/** Deterministic pseudo-random in [0, 1) for index `i`. */
export const hash = (i) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
