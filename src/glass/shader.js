// One fragment shader, five glass surfaces. Every mode answers the same
// question for a pixel: "how far am I from the glass edge, and which way
// does the surface face?" `shade()` then bends the ef-surface texture
// along that normal.
//
// Coordinates are y-down design pixels (0..uRes), matching the DOM and the
// orientation canvases upload in, so no texture flip is needed.

export const MODE = { SDF: 0, BLOBS: 1, REEDED: 2, PANELS: 3, WATER: 4, EXTRUDE: 5, RAIN: 6, SHATTER: 7 };

export const GLASS_FS = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;

uniform sampler2D uScene;
uniform vec2 uRes;
uniform float uTime;
uniform int uMode;

// look
uniform float uRefract;
uniform float uDispersion;
uniform float uFrost;
uniform float uRim;
uniform float uSpecular;
uniform vec3 uLightDir;
uniform float uSweep;
uniform float uShadow;
uniform vec3 uTint;
uniform float uTintAmt;
uniform float uBevel;
uniform float uProfile;
uniform float uGlassOnly;
uniform float uBgDim;
uniform float uBgBlur;
uniform float uBgZoom;
uniform float uOpacity;

// MODE.SDF: a distance field on a plane placed in 3D by a homography
uniform sampler2D uSdf;
uniform vec2 uSdfPlane;
uniform mat3 uInvH;
uniform float uPlaneScale;
uniform float uReveal;
uniform float uRevealSoft;
uniform float uInflate;

// MODE.BLOBS
uniform vec4 uBlobs[10];
uniform int uBlobCount;
uniform float uBlend;

// MODE.REEDED
uniform vec4 uPanel;
uniform float uPanelRadius;
uniform float uRibWidth;
uniform float uRibDepth;

// MODE.PANELS
uniform vec4 uRects[24];
uniform vec4 uRectLook[24];
uniform int uRectCount;

// Before/after comparison: left of uSplit uses uDispersion2 instead.
uniform float uSplit;
uniform float uDispersion2;

// MODE.WATER
uniform vec4 uRipples[16];
uniform int uRippleCount;
uniform float uWaveSpeed;
uniform float uAmbient;

// MODE.EXTRUDE: the SDF extruded into a solid slab and raymarched.
// World space is design px, y down, z toward the viewer; z = 0 is the screen.
uniform mat3 uSolidRot;    // object -> world rotation
uniform mat3 uSolidInv;    // world -> object rotation
uniform vec3 uSolidPos;
uniform float uSolidScale; // world px per plane px
uniform vec3 uEye;
uniform float uDepth;      // half thickness, plane px
uniform float uRound;      // edge radius, plane px
uniform float uIor;
uniform float uBgDepth;    // how far behind the glass the footage sits
uniform float uMilk;       // frosted scattering, grows with thickness

// MODE.RAIN
uniform float uFog;
uniform float uRain;
uniform float uLens;

// MODE.SHATTER: uScene2 is the frozen frame that breaks; uScene shows through.
uniform sampler2D uScene2;
uniform vec2 uImpact;
uniform float uShatter;    // seconds since impact
uniform float uCell;

struct Surface {
  float d;       // signed distance to the glass edge, px (< 0 inside)
  vec3 n;        // unit surface normal (y-down screen space, z toward viewer)
  float frost;   // extra blur (mip levels)
  float refract; // multiplier on uRefract
  float bevel;   // bevel width used for the rim band
};

vec3 scene(vec2 px, float lod) {
  vec2 uv = (px - uRes * 0.5) / uBgZoom + uRes * 0.5;
  return textureLod(uScene, clamp(uv / uRes, vec2(0.0005), vec2(0.9995)), lod).rgb;
}

// Mip-level blur smoothed with a golden-angle disk so it never looks blocky.
vec3 sceneSoft(vec2 px, float lod) {
  if (lod < 0.25) return scene(px, 0.0);
  float r = exp2(lod) * 0.75;
  vec3 c = scene(px, lod);
  float w = 1.0;
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    float a = fi * 2.39996;
    vec2 o = vec2(cos(a), sin(a)) * r * sqrt((fi + 0.5) / 10.0) * 2.2;
    c += scene(px + o, lod);
    w += 1.0;
  }
  return c / w;
}

// Spectral dispersion: nine wavelengths, each bent by a slightly different
// index of refraction. Blue bends most, red least, so edges split into a
// smooth rainbow instead of three hard RGB fringes.
vec3 refracted(vec2 px, vec2 disp, float lod) {
  float dispersion = px.x < uSplit ? uDispersion2 : uDispersion;
  if (dispersion < 0.001) return lod > 0.25 ? sceneSoft(px + disp, lod) : scene(px + disp, 0.0);
  vec3 acc = vec3(0.0);
  vec3 wsum = vec3(0.0);
  for (int i = 0; i < 9; i++) {
    float t = float(i) / 8.0;
    vec3 w = vec3(
      exp(-pow((t - 0.10) / 0.26, 2.0)),
      exp(-pow((t - 0.50) / 0.24, 2.0)),
      exp(-pow((t - 0.90) / 0.26, 2.0))
    );
    float k = 1.0 + dispersion * (t - 0.5) * 0.8;
    acc += scene(px + disp * k, lod) * w;
    wsum += w;
  }
  return acc / wsum;
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float sdRoundRect(vec2 p, vec2 c, vec2 hs, float r) {
  vec2 q = abs(p - c) - hs + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Rounded bevel: 0 at the edge, rising to 1 over "bevel" px. uProfile < 1
// makes a pillowy dome, > 1 a flatter slab with a tight rounded edge.
float bevelHeight(float d, float bevel) {
  float t = clamp(-d / bevel, 0.0, 1.0);
  t = 1.0 - pow(1.0 - t, uProfile);
  return sqrt(max(1.0 - (1.0 - t) * (1.0 - t), 0.0)) * bevel;
}

// ---- MODE.SDF ------------------------------------------------------------
vec2 toPlane(vec2 px) {
  vec3 q = uInvH * vec3(px, 1.0);
  return q.xy / q.z;
}

float sdPlane(vec2 px) {
  vec2 q = toPlane(px);
  vec2 uv = q / uSdfPlane;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 400.0;
  float d = texture(uSdf, uv).r;
  // Reveal sweeps left to right; unrevealed glass "deflates" to its skeleton.
  float front = clamp((uReveal * (1.0 + uRevealSoft) - uv.x) / uRevealSoft, 0.0, 1.0);
  front = front * front * (3.0 - 2.0 * front);
  d += (1.0 - front) * uBevel * 2.6 + uInflate;
  return d * uPlaneScale;
}

// ---- MODE.BLOBS ----------------------------------------------------------
float sdBlobs(vec2 p) {
  float d = 1e5;
  for (int i = 0; i < 10; i++) {
    if (i >= uBlobCount) break;
    vec4 b = uBlobs[i];
    d = smin(d, length(p - b.xy) - b.z, uBlend);
  }
  return d;
}

// ---- MODE.PANELS ---------------------------------------------------------
// Union of rounded rects; the nearest rect decides blur / bevel / strength.
float sdPanels(vec2 p, out vec4 look) {
  float d = 1e5;
  look = vec4(0.0, 0.0, 18.0, 1.0);
  for (int i = 0; i < 24; i++) {
    if (i >= uRectCount) break;
    vec4 r = uRects[i];
    vec4 l = uRectLook[i];
    float di = sdRoundRect(p, r.xy, r.zw, l.x);
    if (di < d) { d = di; look = l; }
  }
  return d;
}

// ---- MODE.WATER ----------------------------------------------------------
float waterHeight(vec2 p) {
  float h = uAmbient * (
    sin(p.x * 0.011 + uTime * 1.3) * sin(p.y * 0.014 - uTime * 1.1) +
    0.5 * sin(p.x * 0.023 - p.y * 0.019 + uTime * 2.1)
  );
  for (int i = 0; i < 16; i++) {
    if (i >= uRippleCount) break;
    vec4 r = uRipples[i];
    float age = uTime - r.z;
    if (age < 0.0) continue;
    float dist = length(p - r.xy);
    float x = dist - age * uWaveSpeed;
    float packet = exp(-x * x / (2.0 * 90.0 * 90.0));
    float decay = exp(-age * 0.9) / (1.0 + dist * 0.0025);
    h += r.w * sin(x * 0.045) * packet * decay;
  }
  return h;
}

float heightAt(vec2 p, out float d) {
  if (uMode == 0) { d = sdPlane(p); return bevelHeight(d, uBevel * uPlaneScale); }
  if (uMode == 1) { d = sdBlobs(p); return bevelHeight(d, uBevel); }
  vec4 look; d = sdPanels(p, look); return bevelHeight(d, look.z);
}

Surface surfaceAt(vec2 px) {
  Surface s;
  s.frost = 0.0;
  s.refract = 1.0;
  s.bevel = uBevel;
  if (uMode == 2) {
    s.d = sdRoundRect(px, uPanel.xy, uPanel.zw, uPanelRadius);
    float local = fract((px.x - (uPanel.x - uPanel.z)) / uRibWidth);
    float u = local * 2.0 - 1.0;
    float slope = -u / sqrt(max(1.0 - u * u, 0.02));
    // Rounded panel edge on top of the ribs.
    float e = 1.5;
    float h0 = bevelHeight(s.d, 26.0);
    float hx = bevelHeight(sdRoundRect(px + vec2(e, 0.0), uPanel.xy, uPanel.zw, uPanelRadius), 26.0);
    float hy = bevelHeight(sdRoundRect(px + vec2(0.0, e), uPanel.xy, uPanel.zw, uPanelRadius), 26.0);
    s.n = normalize(vec3(-slope * uRibDepth - (hx - h0) / e, -(hy - h0) / e, 1.0));
    s.bevel = 26.0;
    return s;
  }
  if (uMode == 4) {
    float e = 2.0;
    float hl = waterHeight(px - vec2(e, 0.0));
    float hr = waterHeight(px + vec2(e, 0.0));
    float hu = waterHeight(px - vec2(0.0, e));
    float hd = waterHeight(px + vec2(0.0, e));
    s.d = -1000.0;
    s.n = normalize(vec3(-(hr - hl) / (2.0 * e), -(hd - hu) / (2.0 * e), 1.0));
    return s;
  }
  float d0, dx, dy, dl, du;
  float e = 1.25;
  heightAt(px, d0);
  float hr = heightAt(px + vec2(e, 0.0), dx);
  float hl = heightAt(px - vec2(e, 0.0), dl);
  float hd = heightAt(px + vec2(0.0, e), dy);
  float hu = heightAt(px - vec2(0.0, e), du);
  s.d = d0;
  s.n = normalize(vec3(-(hr - hl) / (2.0 * e), -(hd - hu) / (2.0 * e), 1.0));
  if (uMode == 3) {
    vec4 look;
    sdPanels(px, look);
    s.frost = look.y;
    s.bevel = look.z;
    s.refract = look.w;
  }
  if (uMode == 0) s.bevel = uBevel * uPlaneScale;
  return s;
}

float shadowDistance(vec2 px) {
  vec2 o = vec2(14.0, 26.0);
  float d;
  if (uMode == 0) d = sdPlane(px - o);
  else if (uMode == 1) d = sdBlobs(px - o);
  else if (uMode == 2) d = sdRoundRect(px - o, uPanel.xy, uPanel.zw, uPanelRadius);
  else { vec4 look; d = sdPanels(px - o, look); }
  return d;
}

// ---- MODE.EXTRUDE --------------------------------------------------------
float sdText(vec2 q, out float front) {
  front = 1.0;
  vec2 o = max(abs(q) - uSdfPlane * 0.5, 0.0);
  if (o.x > 0.0 || o.y > 0.0) return length(o) + 200.0;
  vec2 uv = q / uSdfPlane + 0.5;
  float d = texture(uSdf, uv).r;
  front = clamp((uReveal * (1.0 + uRevealSoft) - uv.x) / uRevealSoft, 0.0, 1.0);
  front = front * front * (3.0 - 2.0 * front);
  return d + (1.0 - front) * 150.0 + uInflate;
}

// Rounded extrusion of the 2D field: a slab uDepth thick with uRound edges.
float sdSolid(vec3 p) {
  float front;
  float d2 = sdText(p.xy, front);
  float hd = uDepth * mix(0.25, 1.0, front);
  float r = min(uRound, hd);
  vec2 w = vec2(d2 + r, abs(p.z) - hd + r);
  return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - r;
}

// Tetrahedral gradient with a few px footprint: a bilinear distance texture
// has a piecewise-constant gradient, so a tight epsilon stripes the walls.
vec3 solidNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float e = 2.5;
  return normalize(
    k.xyy * sdSolid(p + k.xyy * e) + k.yyx * sdSolid(p + k.yyx * e) +
    k.yxy * sdSolid(p + k.yxy * e) + k.xxx * sdSolid(p + k.xxx * e));
}

vec2 boxHit(vec3 ro, vec3 rd, vec3 b) {
  vec3 m = 1.0 / rd;
  vec3 n = m * ro;
  vec3 k = abs(m) * b;
  vec3 t1 = -n - k;
  vec3 t2 = -n + k;
  return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
}

vec2 toScreen(vec3 w) {
  return uEye.xy + (w.xy - uEye.xy) * (uEye.z / (uEye.z - w.z));
}

// Where a ray leaving the glass lands on the footage plane (as screen px).
vec2 footageHit(vec3 o, vec3 d) {
  float z = -uBgDepth;
  if (d.z > -0.05) return toScreen(vec3(o.xy + d.xy * 600.0, z));
  return toScreen(o + d * ((z - o.z) / d.z));
}

// A soft studio: overhead softbox, a strip light, and the footage itself
// (so reflections pick up the scene's own colors).
vec3 studio(vec3 r, vec2 px) {
  float top = smoothstep(-0.2, -0.85, r.y);
  float left = exp(-pow((r.x + 0.7) / 0.22, 2.0)) * smoothstep(0.8, -0.4, r.y);
  vec3 room = sceneSoft(px + r.xy * 320.0, 5.0);
  return room * 1.05 + vec3(1.0, 0.97, 0.93) * (top * 0.75 + left * 0.45);
}

vec3 backdrop(vec2 px) {
  vec3 bg = uBgBlur > 0.01 ? sceneSoft(px, uBgBlur) : scene(px, 0.0);
  return bg * (1.0 - uBgDim);
}

float solidShadow(vec2 px) {
  vec2 sp = px - vec2(22.0, 40.0) * uSolidScale;
  vec3 ro = uSolidInv * (uEye - uSolidPos) / uSolidScale;
  vec3 rd = uSolidInv * normalize(vec3(sp, 0.0) - uEye);
  vec3 p = ro + rd * ((-uDepth - ro.z) / rd.z);
  float front;
  float d = sdText(p.xy, front);
  return 1.0 - smoothstep(-40.0, 70.0, d * uSolidScale);
}

vec4 extrude(vec2 px) {
  vec3 rdW = normalize(vec3(px, 0.0) - uEye);
  vec3 ro = uSolidInv * (uEye - uSolidPos) / uSolidScale;
  vec3 rd = normalize(uSolidInv * rdW);
  vec3 bg = backdrop(px);
  if (uShadow > 0.0) bg *= 1.0 - uShadow * solidShadow(px);

  vec2 tb = boxHit(ro, rd, vec3(uSdfPlane * 0.5, uDepth + 2.0));
  if (tb.x > tb.y || tb.y < 0.0) return vec4(bg, 0.0);

  float t = max(tb.x, 0.0);
  float fp = 1.0 / uSolidScale;
  float dmin = 1e5;
  float tmin = t;
  bool hit = false;
  for (int i = 0; i < 160; i++) {
    float d = sdSolid(ro + rd * t);
    if (d < dmin) { dmin = d; tmin = t; }
    if (d < 0.04) { hit = true; tmin = t; break; }
    t += max(d * 0.85, 0.08);
    if (t > tb.y) break;
  }
  float cov = hit ? 1.0 : 1.0 - smoothstep(0.0, fp * 1.25, dmin);
  if (cov <= 0.0) return vec4(bg, 0.0);

  vec3 p = ro + rd * tmin;
  vec3 nO = solidNormal(p);
  vec3 n = normalize(uSolidRot * nO);
  float cosi = clamp(dot(-rdW, n), 0.0, 1.0);
  float F = 0.04 + 0.96 * pow(1.0 - cosi, 5.0);

  // Refract in, walk through the slab, refract out per wavelength.
  vec3 r1 = refract(rd, nO, 1.0 / uIor);
  vec3 q = p - nO * 0.6;
  float travel = 0.0;
  for (int i = 0; i < 64; i++) {
    float d = -sdSolid(q);
    if (d < 0.05) break;
    float s = max(d * 0.95, 0.6);
    q += r1 * s;
    travel += s;
  }
  // Land exactly on the exit surface so neighbouring pixels agree.
  for (int i = 0; i < 2; i++) {
    float d = sdSolid(q);
    q -= r1 * d;
    travel -= d;
  }
  vec3 nx = solidNormal(q);
  vec3 qW = uSolidPos + uSolidRot * (q * uSolidScale);
  float travelW = travel * uSolidScale;
  float lod = uFrost + travelW * 0.012 * uMilk;
  vec3 col;
  bool tir = false;
  for (int c = 0; c < 3; c++) {
    float ior = uIor * (1.0 + (float(c) - 1.0) * uDispersion * 0.035);
    vec3 r2 = refract(r1, -nx, ior);
    if (dot(r2, r2) < 0.5) { r2 = reflect(r1, -nx); tir = true; }
    vec2 s = footageHit(qW, normalize(uSolidRot * r2));
    col[c] = (lod > 0.25 ? sceneSoft(s, lod) : scene(s, 0.0))[c];
  }
  if (tir) col *= 0.6;

  // Frosted acrylic: light scattered inside the slab takes on the colors
  // around it, more where the path through the glass is longer.
  float milk = uMilk * (1.0 - exp(-travelW * 0.01));
  vec3 scatter = sceneSoft(px, 5.5) * 1.15 + 0.06;
  vec3 glow = mix(col, scatter, 0.55) + vec3(0.1, 0.095, 0.09) * (0.6 + 0.4 * (1.0 - n.y));
  col = mix(col, glow, milk * 0.85);
  col = mix(col, col * uTint, uTintAmt);
  col *= 1.0 - uBgDim * 0.5;

  vec3 R = reflect(rdW, n);
  col = mix(col, studio(R, px), clamp(F * 0.7, 0.0, 1.0));

  vec3 L = normalize(uLightDir);
  vec3 H = normalize(L - rdW);
  float nh = max(dot(n, H), 0.0);
  col += (pow(nh, 160.0) * 1.6 + pow(nh, 14.0) * 0.08) * uSpecular;

  // Rounded edges catch a thin bright line, like the reference's glass type.
  float an = abs(nO.z);
  col += smoothstep(0.97, 0.7, an) * smoothstep(0.05, 0.4, an) * uRim * 0.35;

  float diag = px.x / uRes.x + px.y / uRes.y * 0.45;
  col += exp(-pow((diag - uSweep) / 0.05, 2.0)) * (0.1 + F * 1.4) * uSpecular;

  return vec4(uGlassOnly > 0.5 ? col : mix(bg, col, cov), cov);
}

// ---- hashes --------------------------------------------------------------
float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 h22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

// ---- MODE.RAIN -----------------------------------------------------------
// Drops are tiny fisheye lenses: each one shows the scene behind it flipped
// and sharp, while the fogged pane around them stays blurred.
struct Drop { vec2 o; float m; float r; };

void keep(inout Drop best, vec2 o, float m, float r) {
  if (m > best.m) { best.o = o; best.m = m; best.r = r; }
}

void staticDrops(vec2 px, float cell, float seed, inout Drop best) {
  vec2 id = floor(px / cell);
  vec2 f = px / cell - id - 0.5;
  if (h21(id + seed) < 0.45) return;
  vec2 c = (h22(id + seed * 1.7) - 0.5) * 0.5;
  float r = mix(0.08, 0.27, pow(h21(id + seed + 4.1), 2.5));
  r *= clamp((uRain * 1.4 - h21(id + seed + 9.3)) * 3.0, 0.0, 1.0);
  if (r < 0.01) return;
  vec2 o = (f - c) / r;
  keep(best, o, 1.0 - smoothstep(0.8, 1.0, length(o)), r * cell);
}

float dropX(float id, float seed, float y, float w) {
  return (id + 0.5) * w + (h11(id + seed + 9.0) - 0.5) * w * 0.4
    + sin(y * 0.011 + id * 3.1) * 9.0 + sin(y * 0.033 + id) * 3.0;
}

void slidingDrops(vec2 px, float w, float seed, inout Drop best, inout float clear) {
  float id = floor(px.x / w);
  if (h11(id * 1.37 + seed) < 0.25) return;
  float rate = mix(0.06, 0.13, h11(id + seed + 2.0));
  float tt = uTime * rate + h11(id + seed + 5.0);
  // stick-slip: long pauses, then quick slides
  float cyc = tt + 0.85 * sin(tt * 25.13) / 25.13;
  float span = uRes.y + 900.0;
  float y = fract(cyc) * span - 300.0;
  float R = mix(16.0, 30.0, h11(id + seed + 7.0)) * clamp(uRain * 2.0 - 0.4, 0.0, 1.0);
  if (R < 1.0) return;
  vec2 o = (px - vec2(dropX(id, seed, y, w), y)) / R;
  o.y *= o.y < 0.0 ? 0.72 : 1.0;
  keep(best, o, 1.0 - smoothstep(0.8, 1.0, length(o)), R);

  float above = y - px.y;
  if (above > 0.0 && above < 420.0) {
    float xp = dropX(id, seed, px.y, w);
    float fade = 1.0 - above / 420.0;
    float tw = R * 0.55 * (0.4 + 0.6 * fade);
    clear = max(clear, (1.0 - smoothstep(tw * 0.6, tw, abs(px.x - xp))) * fade);
    float spacing = 30.0;
    float bead = floor(px.y / spacing);
    float hb = h11(bead + id * 13.0 + seed);
    float rb = R * mix(0.16, 0.34, hb) * fade;
    if (rb > 1.0 && above > R * 1.6 && hb > 0.3) {
      vec2 ob = vec2(px.x - xp - (hb - 0.5) * 8.0, mod(px.y, spacing) - spacing * 0.5) / rb;
      keep(best, ob, 1.0 - smoothstep(0.8, 1.0, length(ob)), rb);
    }
  }
}

vec3 rain(vec2 px) {
  Drop d = Drop(vec2(0.0), 0.0, 1.0);
  float clear = 0.0;
  staticDrops(px, 34.0, 1.0, d);
  staticDrops(px + vec2(17.0, 11.0), 22.0, 7.0, d);
  slidingDrops(px, 150.0, 3.0, d, clear);
  slidingDrops(px + vec2(75.0, 0.0), 210.0, 11.0, d, clear);

  vec3 sharp = scene(px, 0.0);
  vec3 fogged = sceneSoft(px, 4.2) * 0.8 + vec3(0.075, 0.08, 0.09);
  vec3 col = mix(sharp, fogged, uFog * (1.0 - clear * 0.9));
  if (d.m > 0.0) {
    float l = length(d.o);
    vec3 n = normalize(vec3(d.o, sqrt(max(1.0 - l * l, 0.0)) + 0.25));
    vec3 dc = scene(px - d.o * d.r * uLens, 0.0) * 1.1 + 0.03;
    dc *= mix(1.0, 0.42, smoothstep(0.72, 1.0, l));
    dc += pow(max(dot(n, normalize(vec3(-0.45, -0.65, 1.0))), 0.0), 60.0) * 0.85;
    dc += smoothstep(0.55, 0.9, l) * smoothstep(1.0, 0.88, l) * max(-d.o.y, 0.0) * 0.18;
    col = mix(col, dc, d.m);
  }
  return col;
}

// ---- MODE.SHATTER --------------------------------------------------------
vec2 seedAt(vec2 id) { return (id + 0.5 + (h22(id) - 0.5) * 0.85) * uCell; }

vec2 nearestSeed(vec2 p) {
  vec2 g = floor(p / uCell);
  float d1 = 1e12;
  vec2 id1 = g;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 id = g + vec2(i, j);
      vec2 s = seedAt(id);
      float d = dot(p - s, p - s);
      if (d < d1) { d1 = d; id1 = id; }
    }
  }
  return id1;
}

float cellBorder(vec2 p, vec2 id1) {
  vec2 s1 = seedAt(id1);
  float edge = 1e6;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      if (i == 0 && j == 0) continue;
      vec2 s = seedAt(id1 + vec2(i, j));
      edge = min(edge, dot((s1 + s) * 0.5 - p, normalize(s - s1)));
    }
  }
  return edge;
}

const float CRACK_SPEED = 2800.0;
const float HOLD = 0.3;

float shardLife(vec2 s) { return max(uShatter - HOLD - length(s - uImpact) / CRACK_SPEED, 0.0); }
float expansion(float lt) { return 1.0 + lt * 0.75 + lt * lt * 0.9; }
vec2 gravity(float lt) { return vec2(0.0, 520.0 * lt * lt); }

vec3 shatter(vec2 px) {
  vec3 behind = scene(px, 0.0);
  if (uShatter <= 0.0) return texture(uScene2, px / uRes).rgb;
  behind *= mix(0.3, 1.0, smoothstep(HOLD + 0.1, HOLD + 1.1, uShatter));

  // Undo the average outward burst to find which shards could cover px.
  vec2 q = px;
  for (int k = 0; k < 3; k++) {
    float lt = shardLife(q);
    q = uImpact + (px - gravity(lt) - uImpact) / expansion(lt);
  }
  vec2 g = floor(q / uCell);
  float bestScale = -1.0;
  vec2 bestId = vec2(0.0);
  vec2 bestLocal = px;
  float bestLt = 0.0;
  float bestFace = 1.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 id = g + vec2(i, j);
      vec2 s = seedAt(id);
      float lt = shardLife(s);
      if (lt > 1.5) continue;
      float h = h21(id + 3.7);
      float scale = 1.0 + lt * (0.5 + 1.1 * h);
      if (scale < bestScale) continue;
      vec2 jitter = (h22(id + 1.3) - 0.5) * 160.0 * lt;
      vec2 center = uImpact + (s - uImpact) * expansion(lt) + gravity(lt) + jitter;
      float rot = (h - 0.5) * 4.0 * lt;
      float axis = h21(id + 9.1) * 6.2832;
      float sq = cos(lt * (2.5 + 4.0 * h21(id + 5.3)));
      // Inverse of the shard's tumble: undo scale, spin, then the squash
      // that fakes it turning edge-on.
      vec2 v = mat2(cos(rot), -sin(rot), sin(rot), cos(rot)) * (px - center) / scale;
      vec2 ax = vec2(cos(axis), sin(axis));
      v += ax * dot(v, ax) * (1.0 / max(abs(sq), 0.06) - 1.0);
      vec2 local = s + v;
      if (nearestSeed(local) != id) continue;
      bestScale = scale;
      bestId = id;
      bestLocal = local;
      bestLt = lt;
      bestFace = abs(sq);
    }
  }
  vec3 col = behind;
  if (bestScale > 0.0) {
    float moving = bestLt > 0.0 ? 1.0 : 0.0;
    float h = h21(bestId + 3.7);
    vec2 tilt = vec2(cos(h * 6.2832), sin(h * 6.2832));
    vec3 c = texture(uScene2, clamp(bestLocal / uRes, vec2(0.0), vec2(1.0))).rgb;
    c = mix(c, scene(px + tilt * (1.0 - bestFace) * 70.0, 0.0), 0.2 * moving);
    c *= mix(0.62, 1.0, bestFace);
    c += pow(1.0 - bestFace, 14.0) * 0.7;
    c = c * 1.04 + 0.02;
    float band = dot(bestLocal - seedAt(bestId), tilt.yx) / uCell + bestLt * 2.4 + h * 3.0;
    c += pow(max(sin(band * 3.1416), 0.0), 10.0) * 0.32 * moving;
    float edgePx = cellBorder(bestLocal, bestId) * bestScale;
    c += (1.0 - smoothstep(0.0, 3.5, edgePx)) * 0.55 * moving;
    c += (1.0 - smoothstep(0.0, 12.0, edgePx)) * 0.14 * moving;
    float cracked = step(length(seedAt(bestId) - uImpact), uShatter * CRACK_SPEED);
    c = mix(c, vec3(1.0), (1.0 - smoothstep(0.4, 1.6, edgePx)) * cracked * mix(0.8, 0.3, moving));
    col = mix(behind, c, 1.0 - smoothstep(0.8, 1.5, bestLt));
  }
  return col + exp(-uShatter * 9.0) * 0.12;
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  if (uMode == 5) {
    vec4 e = extrude(px);
    outColor = uGlassOnly > 0.5 ? vec4(e.rgb * e.a, e.a) : vec4(e.rgb, 1.0);
    return;
  }
  if (uMode == 6) { outColor = vec4(rain(px), 1.0); return; }
  if (uMode == 7) { outColor = vec4(shatter(px), 1.0); return; }
  Surface s = surfaceAt(px);
  float mask = uMode == 4 ? 1.0 : smoothstep(0.9, -0.9, s.d);

  vec3 bg = uBgBlur > 0.01 ? sceneSoft(px, uBgBlur) : scene(px, 0.0);
  bg *= 1.0 - uBgDim;
  if (uShadow > 0.0 && uMode != 4) {
    float sd = shadowDistance(px);
    bg *= 1.0 - uShadow * (1.0 - smoothstep(-20.0, 46.0, sd)) * (1.0 - mask);
  }

  if (mask <= 0.0) {
    outColor = uGlassOnly > 0.5 ? vec4(0.0) : vec4(bg, 1.0);
    return;
  }

  vec3 n = s.n;
  vec2 disp = -n.xy * uRefract * s.refract;
  float lod = uFrost + s.frost;
  vec3 col = refracted(px, disp, lod);
  col = mix(col, col * uTint, uTintAmt);

  float cosT = clamp(n.z, 0.0, 1.0);
  float fres = pow(1.0 - cosT, 3.0);
  vec3 refl = sceneSoft(px - n.xy * 260.0 - vec2(0.0, 90.0), 4.5);
  col = mix(col, refl * 1.3 + 0.05, fres * 0.6);

  vec3 L = normalize(uLightDir);
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, H), 0.0), 120.0) * 1.3;
  vec3 L2 = normalize(vec3(-L.xy, L.z * 0.6));
  float spec2 = pow(max(dot(n, normalize(L2 + vec3(0.0, 0.0, 1.0))), 0.0), 30.0) * 0.22;
  col += (spec + spec2) * uSpecular;

  float diag = px.x / uRes.x + px.y / uRes.y * 0.45;
  float sweep = exp(-pow((diag - uSweep) / 0.06, 2.0));
  col += sweep * (0.10 + fres * 0.9) * uSpecular;

  if (uMode != 4) {
    float rimLine = exp(-abs(s.d + 0.9) / 1.3);
    float band = smoothstep(-1.5, -0.35 * s.bevel, s.d) * smoothstep(-0.9 * s.bevel, -0.35 * s.bevel, s.d);
    col += rimLine * uRim * 0.5;
    col *= 1.0 - band * 0.16;
    col += fres * uRim * 0.35;
  }

  if (uGlassOnly > 0.5) {
    float a = mask * uOpacity;
    outColor = vec4(col * a, a);
    return;
  }
  outColor = vec4(mix(bg, col, mask * uOpacity), 1.0);
}
`;
