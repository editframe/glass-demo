// Signed distance fields for glass shapes. A shape is rasterized to a 2D
// canvas, then an exact Euclidean distance transform (Felzenszwalb, as in
// Mapbox's TinySDF) turns coverage into signed pixel distances: negative
// inside, positive outside. The shader derives the bevel height and the
// surface normal from this field, so any font or Path2D can become glass.

const INF = 1e20;
const cache = new Map();

function edt1d(grid, offset, stride, length, f, v, z) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    const qr = q - r;
    grid[offset + q * stride] = f[r] + qr * qr;
  }
}

function edt(grid, width, height) {
  const n = Math.max(width, height);
  const f = new Float64Array(n);
  const v = new Uint16Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < width; x++) edt1d(grid, x, width, height, f, v, z);
  for (let y = 0; y < height; y++) edt1d(grid, y * width, 1, width, f, v, z);
}

/** Converts a canvas's alpha coverage into a Float32Array of signed distances (in design px). */
export function coverageToSdf(canvas, pxScale = 1) {
  const { width, height } = canvas;
  const alpha = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  const len = width * height;
  const outer = new Float64Array(len);
  const inner = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    const a = alpha[i * 4 + 3] / 255;
    if (a === 1) {
      outer[i] = 0;
      inner[i] = INF;
    } else if (a === 0) {
      outer[i] = INF;
      inner[i] = 0;
    } else {
      const d = 0.5 - a;
      outer[i] = d > 0 ? d * d : 0;
      inner[i] = d < 0 ? d * d : 0;
    }
  }
  edt(outer, width, height);
  edt(inner, width, height);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = (Math.sqrt(outer[i]) - Math.sqrt(inner[i])) / pxScale;
  return out;
}

/**
 * Builds (and caches) the SDF for one or more lines of text laid out on a
 * `width` x `height` design plane. Resolves after the font is loaded.
 */
export async function textSdf({
  lines,
  font,
  size,
  width = 1920,
  height = 1080,
  lineHeight = 0.92,
  tracking = 0,
  align = "center",
  x,
  y,
  scale = 1,
  italic = false,
}) {
  const key = JSON.stringify(arguments[0]);
  if (cache.has(key)) return cache.get(key);
  const promise = (async () => {
    const weightFamily = `${italic ? "italic " : ""}${font.weight ?? 400} ${size}px ${font.family}`;
    await document.fonts.load(weightFamily, lines.join(""));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.scale(scale, scale);
    ctx.font = weightFamily;
    ctx.letterSpacing = `${tracking}px`;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    const cx = x ?? (align === "left" ? 0 : align === "right" ? width : width / 2);
    const cy = y ?? height / 2;
    const step = size * lineHeight;
    lines.forEach((line, i) => {
      const ly = cy + (i - (lines.length - 1) / 2) * step;
      ctx.fillText(line, cx, ly + size * (font.baselineShift ?? 0));
    });
    return {
      data: coverageToSdf(canvas, scale),
      width: canvas.width,
      height: canvas.height,
      planeWidth: width,
      planeHeight: height,
    };
  })();
  cache.set(key, promise);
  return promise;
}

/** SDF for arbitrary drawing (logos, icons): `paint(ctx)` draws in design px. */
export async function shapeSdf(key, { width = 1920, height = 1080, scale = 1 }, paint) {
  const cacheKey = `shape:${key}:${width}x${height}@${scale}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const promise = (async () => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.scale(scale, scale);
    ctx.fillStyle = "#fff";
    await paint(ctx);
    return {
      data: coverageToSdf(canvas, scale),
      width: canvas.width,
      height: canvas.height,
      planeWidth: width,
      planeHeight: height,
    };
  })();
  cache.set(cacheKey, promise);
  return promise;
}
