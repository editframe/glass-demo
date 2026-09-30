import { createContext, createProgram, createTexture, uploadCanvas, uploadFloat, draw } from "./gl.js";
import { GLASS_FS, MODE } from "./shader.js";

export { MODE };

const DEFAULTS = {
  uRefract: 70,
  uDispersion: 0.6,
  uFrost: 0,
  uRim: 0.8,
  uSpecular: 1,
  uLightDir: [-0.55, -0.8, 0.9],
  uSweep: -1,
  uShadow: 0.35,
  uTint: [0.92, 0.97, 1.0],
  uTintAmt: 0.25,
  uBevel: 34,
  uProfile: 1,
  uGlassOnly: 0,
  uBgDim: 0,
  uBgBlur: 0,
  uBgZoom: 1,
  uOpacity: 1,
  uPlaneScale: 1,
  uReveal: 1,
  uRevealSoft: 0.35,
  uInflate: 0,
  uBlend: 60,
  uPanelRadius: 36,
  uRibWidth: 44,
  uRibDepth: 0.9,
  uWaveSpeed: 520,
  uAmbient: 0,
  uSplit: -1,
  uDispersion2: 0,
  uSolidScale: 1,
  uDepth: 60,
  uRound: 16,
  uIor: 1.5,
  uBgDepth: 500,
  uMilk: 0.6,
  uFog: 0.85,
  uRain: 1,
  uLens: 4,
  uShatter: -1,
  uCell: 190,
};

const WIDTH = 1920;
const HEIGHT = 1080;

// Browsers cap live WebGL contexts per page (~16), and an export clone
// doubles every scene, so all scenes share one offscreen context and blit
// the result into their own 2D canvas.
let engine = null;
function getEngine() {
  if (engine) return engine;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const gl = createContext(canvas);
  const empty = createTexture(gl);
  uploadFloat(gl, empty, new Float32Array([400]), 1, 1);
  const blank = document.createElement("canvas");
  blank.width = blank.height = 1;
  const scene2 = createTexture(gl);
  uploadCanvas(gl, scene2, blank);
  engine = {
    canvas,
    gl,
    program: createProgram(gl, GLASS_FS),
    scene: createTexture(gl, { mipmaps: true }),
    scene2,
    sdfTextures: new WeakMap(),
    empty,
  };
  return engine;
}

function sdfTexture(sdf) {
  const e = getEngine();
  let tex = e.sdfTextures.get(sdf);
  if (!tex) {
    tex = createTexture(e.gl);
    uploadFloat(e.gl, tex, sdf.data, sdf.width, sdf.height);
    e.sdfTextures.set(sdf, tex);
  }
  return tex;
}

/**
 * A scene's handle on the shared glass engine. Each frame: upload the
 * source canvas (an ef-surface mirror), shade one glass mode over it, and
 * copy the result into this scene's <canvas>.
 */
export class GlassRenderer {
  constructor(target) {
    target.width = WIDTH;
    target.height = HEIGHT;
    this.width = WIDTH;
    this.height = HEIGHT;
    this.ctx = target.getContext("2d");
    this.sdf = null;
  }

  setSdf(sdf) {
    this.sdf = sdf;
  }

  /**
   * `source` is any canvas/image; `uniforms` override DEFAULTS for this frame.
   * `uniforms.source2` (optional) fills uScene2, e.g. a frozen frame to shatter.
   */
  render(source, mode, uniforms = {}) {
    const e = getEngine();
    const { gl } = e;
    uploadCanvas(gl, e.scene, source);
    const sdf = uniforms.sdf ?? this.sdf;
    const plane = sdf ? [sdf.planeWidth, sdf.planeHeight] : [1, 1];
    const { sdf: _sdf, source2, ...rest } = uniforms;
    if (source2) uploadCanvas(gl, e.scene2, source2);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    draw(gl, e.program, {
      width: WIDTH,
      height: HEIGHT,
      textures: { uScene: e.scene, uSdf: sdf ? sdfTexture(sdf) : e.empty, uScene2: e.scene2 },
      uniforms: {
        ...DEFAULTS,
        uRes: [WIDTH, HEIGHT],
        uMode: { int: mode },
        uSdfPlane: { vec2: plane },
        uInvH: { mat3: IDENTITY },
        ...normalize(rest),
      },
    });
    this.ctx.clearRect(0, 0, WIDTH, HEIGHT);
    this.ctx.drawImage(e.canvas, 0, 0);
  }
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

function normalize(uniforms) {
  const out = {};
  for (const [k, v] of Object.entries(uniforms)) {
    if (k === "uBlobs" || k === "uRects" || k === "uRectLook" || k === "uRipples") out[k] = { vec4: flat4(v) };
    else if (k === "uBlobCount" || k === "uRectCount" || k === "uRippleCount") out[k] = { int: v };
    else if (k === "uPanel") out[k] = { vec4: v };
    else if (k === "uInvH") out[k] = { mat3: v };
    else out[k] = v;
  }
  return out;
}

function flat4(list) {
  const arr = new Float32Array(list.length * 4);
  list.forEach((v, i) => arr.set(v, i * 4));
  return arr;
}

// ---------------------------------------------------------------------------
// Plane placement. A glass word lives on a flat plane (its SDF texture). We
// place that plane in 3D (rotate, scale, translate, perspective) and project
// its corners to the screen; the 3x3 homography between plane and screen is
// all the shader needs to sample the SDF with correct perspective.

/**
 * @returns inverse homography (column-major Float32Array) mapping screen px to plane px,
 * plus the average screen-px-per-plane-px scale.
 */
export function placePlane({
  planeWidth,
  planeHeight,
  x = 960,
  y = 540,
  scale = 1,
  rotateX = 0,
  rotateY = 0,
  rotateZ = 0,
  perspective = 1600,
}) {
  const rx = (rotateX * Math.PI) / 180;
  const ry = (rotateY * Math.PI) / 180;
  const rz = (rotateZ * Math.PI) / 180;
  const project = (px, py) => {
    let X = (px - planeWidth / 2) * scale;
    let Y = (py - planeHeight / 2) * scale;
    let Z = 0;
    // rotateZ
    [X, Y] = [X * Math.cos(rz) - Y * Math.sin(rz), X * Math.sin(rz) + Y * Math.cos(rz)];
    // rotateY
    [X, Z] = [X * Math.cos(ry) + Z * Math.sin(ry), -X * Math.sin(ry) + Z * Math.cos(ry)];
    // rotateX (y-down, so positive tilts the top away)
    [Y, Z] = [Y * Math.cos(rx) - Z * Math.sin(rx), Y * Math.sin(rx) + Z * Math.cos(rx)];
    const w = perspective / (perspective - Z);
    return [x + X * w, y + Y * w];
  };
  const src = [
    [0, 0],
    [planeWidth, 0],
    [planeWidth, planeHeight],
    [0, planeHeight],
  ];
  const dst = src.map(([a, b]) => project(a, b));
  const H = homography(src, dst);
  const inv = invert3(H);
  const area = polygonArea(dst) / (planeWidth * planeHeight);
  return { invH: toColumnMajor(inv), planeScale: Math.sqrt(Math.abs(area)), corners: dst };
}

/**
 * Places an extruded slab (MODE.EXTRUDE) with the same conventions as
 * placePlane: rotateZ, then Y, then X, viewed from `perspective` px away.
 */
export function placeSolid({
  x = 960,
  y = 540,
  z = 0,
  scale = 1,
  rotateX = 0,
  rotateY = 0,
  rotateZ = 0,
  perspective = 1600,
}) {
  const [cx, sx] = [Math.cos((rotateX * Math.PI) / 180), Math.sin((rotateX * Math.PI) / 180)];
  const [cy, sy] = [Math.cos((rotateY * Math.PI) / 180), Math.sin((rotateY * Math.PI) / 180)];
  const [cz, sz] = [Math.cos((rotateZ * Math.PI) / 180), Math.sin((rotateZ * Math.PI) / 180)];
  const Rz = [
    [cz, -sz, 0],
    [sz, cz, 0],
    [0, 0, 1],
  ];
  const Ry = [
    [cy, 0, sy],
    [0, 1, 0],
    [-sy, 0, cy],
  ];
  const Rx = [
    [1, 0, 0],
    [0, cx, -sx],
    [0, sx, cx],
  ];
  const R = mul3(Rx, mul3(Ry, Rz));
  const Rt = R[0].map((_, c) => R.map((row) => row[c]));
  return {
    uSolidRot: { mat3: toColumnMajor(R) },
    uSolidInv: { mat3: toColumnMajor(Rt) },
    uSolidPos: [x, y, z],
    uSolidScale: scale,
    uEye: [x, y, perspective],
  };
}

function mul3(a, b) {
  return a.map((row) => b[0].map((_, c) => row[0] * b[0][c] + row[1] * b[1][c] + row[2] * b[2][c]));
}

function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1],
  ];
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

function invert3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

function toColumnMajor(m) {
  return new Float32Array([m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]]);
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}
