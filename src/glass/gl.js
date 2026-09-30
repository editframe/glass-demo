// Minimal WebGL2 plumbing: programs, a full-screen triangle, and textures
// that are re-uploaded from canvases (ef-surface / ef-video) every frame.

export function createContext(canvas) {
  const gl = canvas.getContext("webgl2", {
    // The frame capture reads this canvas with drawImage after the frame task
    // returns, so the drawing buffer has to survive past compositing.
    preserveDrawingBuffer: true,
    premultipliedAlpha: true,
    antialias: false,
    alpha: true,
  });
  if (!gl) throw new Error("WebGL2 unavailable");
  gl.getExtension("EXT_color_buffer_float");
  gl.getExtension("OES_texture_float_linear");
  return gl;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    const numbered = source.split("\n").map((l, i) => `${String(i + 1).padStart(4)} ${l}`).join("\n");
    throw new Error(`Shader compile failed:\n${log}\n${numbered}`);
  }
  return shader;
}

const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export function createProgram(gl, fragmentSource, vertexSource = FULLSCREEN_VS) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  const uniforms = new Map();
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    const name = info.name.replace(/\[0\]$/, "");
    uniforms.set(name, gl.getUniformLocation(program, info.name));
  }
  return { program, uniforms };
}

/** Sets uniforms by inferring the GL call from the JS value's shape. */
export function setUniforms(gl, { uniforms }, values) {
  for (const [name, value] of Object.entries(values)) {
    const loc = uniforms.get(name);
    if (loc == null) continue;
    if (typeof value === "number") gl.uniform1f(loc, value);
    else if (typeof value === "boolean") gl.uniform1i(loc, value ? 1 : 0);
    else if (value?.int !== undefined) gl.uniform1i(loc, value.int);
    else if (value?.mat3) gl.uniformMatrix3fv(loc, false, value.mat3);
    else if (value?.vec4) gl.uniform4fv(loc, value.vec4);
    else if (value?.vec3) gl.uniform3fv(loc, value.vec3);
    else if (value?.vec2) gl.uniform2fv(loc, value.vec2);
    else if (value?.floats) gl.uniform1fv(loc, value.floats);
    else if (Array.isArray(value)) {
      const fn = { 2: "uniform2fv", 3: "uniform3fv", 4: "uniform4fv" }[value.length];
      gl[fn](loc, value);
    }
  }
}

export function createTexture(gl, { mipmaps = false, filter = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE } = {}) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  return { texture, mipmaps, width: 0, height: 0 };
}

/** Uploads a canvas (typically an ef-surface's) and rebuilds its mip chain for cheap blur. */
export function uploadCanvas(gl, tex, source) {
  if (!source || source.width === 0 || source.height === 0) return false;
  gl.bindTexture(gl.TEXTURE_2D, tex.texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  if (tex.mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
  tex.width = source.width;
  tex.height = source.height;
  return true;
}

export function uploadFloat(gl, tex, data, width, height) {
  gl.bindTexture(gl.TEXTURE_2D, tex.texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, width, height, 0, gl.RED, gl.FLOAT, data);
  tex.width = width;
  tex.height = height;
}

/** Draws a full-screen pass into the canvas (or `framebuffer`). */
export function draw(gl, program, { textures = {}, uniforms = {}, width, height, framebuffer = null }) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.viewport(0, 0, width, height);
  gl.useProgram(program.program);
  let unit = 0;
  for (const [name, tex] of Object.entries(textures)) {
    const loc = program.uniforms.get(name);
    if (loc == null) continue;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex.texture);
    gl.uniform1i(loc, unit);
    unit++;
  }
  setUniforms(gl, program, uniforms);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/** Offscreen RGBA target, used when a glass pass feeds another pass. */
export function createTarget(gl, width, height) {
  const tex = createTexture(gl, { mipmaps: true });
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  tex.width = width;
  tex.height = height;
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { ...tex, framebuffer };
}
