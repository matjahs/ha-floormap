import { FULLSCREEN_VERT, makeAccumulateFrag } from "./shader";
import type { LightParams, ToneMap } from "../../types";

const BATCH = 8; // lights per draw when multipassing

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) {
    throw new Error("Failed to create shader");
  }
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile: ${log}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const prog = gl.createProgram();
  if (!prog) {
    throw new Error("Failed to create program");
  }
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`Program link: ${log}`);
  }
  return prog;
}

export interface BakedLightLayer {
  fixtureId: string;
  texture: WebGLTexture;
}

export class BakedCompositor {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null;
  private program: WebGLProgram | null = null;
  private baseTex: WebGLTexture | null = null;
  private layers: BakedLightLayer[] = [];
  private vao: WebGLVertexArrayObject | null = null;
  private lost = false;
  private differenceBaked = false;
  private toneMap: ToneMap = "aces";
  private exposure = 1;
  private width = 1;
  private height = 1;

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement("canvas");
    this.gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      powerPreference: "high-performance",
    });
    if (this.gl) {
      this.initGl(this.gl);
      this.canvas.addEventListener("webglcontextlost", this.onLost, false);
      this.canvas.addEventListener("webglcontextrestored", this.onRestored, false);
    }
  }

  get available(): boolean {
    return this.gl !== null && !this.lost;
  }

  private onLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
  };

  private onRestored = () => {
    this.lost = false;
    if (this.gl) {
      this.initGl(this.gl);
    }
  };

  private initGl(gl: WebGL2RenderingContext): void {
    const vs = compile(gl, gl.VERTEX_SHADER, FULLSCREEN_VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, makeAccumulateFrag(BATCH));
    this.program = link(gl, vs, fs);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
  }

  private uploadImage(gl: WebGL2RenderingContext, img: TexImageSource): WebGLTexture {
    const tex = gl.createTexture();
    if (!tex) {
      throw new Error("createTexture failed");
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    return tex;
  }

  async setBase(image: HTMLImageElement | ImageBitmap): Promise<void> {
    const gl = this.gl;
    if (!gl || !this.available) {
      return;
    }
    this.width = "width" in image ? image.width : 1;
    this.height = "height" in image ? image.height : 1;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    if (this.baseTex) {
      gl.deleteTexture(this.baseTex);
    }
    this.baseTex = this.uploadImage(gl, image);
  }

  clearLayers(): void {
    const gl = this.gl;
    if (gl) {
      for (const layer of this.layers) {
        gl.deleteTexture(layer.texture);
      }
    }
    this.layers = [];
  }

  addLayer(fixtureId: string, image: HTMLImageElement | ImageBitmap): void {
    const gl = this.gl;
    if (!gl || !this.available) {
      return;
    }
    this.layers.push({ fixtureId, texture: this.uploadImage(gl, image) });
  }

  setOptions(opts: { toneMap?: ToneMap; exposure?: number; differenceBaked?: boolean }): void {
    if (opts.toneMap) {
      this.toneMap = opts.toneMap;
    }
    if (opts.exposure !== undefined) {
      this.exposure = opts.exposure;
    }
    if (opts.differenceBaked !== undefined) {
      this.differenceBaked = opts.differenceBaked;
    }
  }

  render(params: Map<string, LightParams>): void {
    const gl = this.gl;
    const program = this.program;
    if (!gl || !program || !this.baseTex || !this.available) {
      return;
    }

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(program);
    gl.bindVertexArray(this.vao);

    const toneMapLoc = gl.getUniformLocation(program, "uToneMap");
    const exposureLoc = gl.getUniformLocation(program, "uExposure");
    const diffLoc = gl.getUniformLocation(program, "uDifferenceBaked");
    gl.uniform1i(toneMapLoc, this.toneMap === "none" ? 0 : this.toneMap === "reinhard" ? 1 : 2);
    gl.uniform1f(exposureLoc, this.exposure);
    gl.uniform1i(diffLoc, this.differenceBaked ? 1 : 0);

    if (this.layers.length <= BATCH) {
      this.drawBatch(gl, program, this.layers, params, true);
      return;
    }

    this.drawBatch(gl, program, this.layers.slice(0, BATCH), params, true);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = BATCH; i < this.layers.length; i += BATCH) {
      this.drawBatch(gl, program, this.layers.slice(i, i + BATCH), params, false);
    }
    gl.disable(gl.BLEND);
  }

  private drawBatch(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    layers: BakedLightLayer[],
    params: Map<string, LightParams>,
    includeBase: boolean,
  ): void {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.baseTex);
    gl.uniform1i(gl.getUniformLocation(program, "uBase"), 0);

    const count = layers.length;
    gl.uniform1i(gl.getUniformLocation(program, "uCount"), includeBase ? count : count);

    for (let i = 0; i < BATCH; i++) {
      const layer = layers[i];
      gl.activeTexture(gl.TEXTURE0 + 1 + i);
      if (layer) {
        gl.bindTexture(gl.TEXTURE_2D, layer.texture);
        const p = params.get(layer.fixtureId);
        gl.uniform1i(gl.getUniformLocation(program, `uCi[${i}]`), 1 + i);
        gl.uniform1f(
          gl.getUniformLocation(program, `uIntensity[${i}]`),
          p?.intensity ?? 0,
        );
        const c = p?.color ?? [1, 1, 1];
        gl.uniform3f(gl.getUniformLocation(program, `uColor[${i}]`), c[0], c[1], c[2]);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, this.baseTex);
        gl.uniform1i(gl.getUniformLocation(program, `uCi[${i}]`), 1 + i);
        gl.uniform1f(gl.getUniformLocation(program, `uIntensity[${i}]`), 0);
        gl.uniform3f(gl.getUniformLocation(program, `uColor[${i}]`), 1, 1, 1);
      }
    }

    if (!includeBase) {
      // Zero-out base contribution by using a 1x1 black — skip for now; intensities alone add Ci
      gl.uniform1f(gl.getUniformLocation(program, "uExposure"), this.exposure);
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    const gl = this.gl;
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    if (gl) {
      this.clearLayers();
      if (this.baseTex) {
        gl.deleteTexture(this.baseTex);
      }
      if (this.program) {
        gl.deleteProgram(this.program);
      }
      if (this.vao) {
        gl.deleteVertexArray(this.vao);
      }
      const ext = gl.getExtension("WEBGL_lose_context");
      ext?.loseContext();
    }
    this.gl = null;
  }
}
