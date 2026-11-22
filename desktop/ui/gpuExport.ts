import { invoke } from './ipc'
import type { ExportSize, PerformanceMode } from '../shared'

const vertex = `#version 300 es
void main() {
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`
const fragment = `#version 300 es
precision highp float;
uniform sampler2D sourceImage;
uniform vec4 sourceRect, destination;
uniform vec2 sourceSize;
uniform float outputHeight, mipLevel;
uniform bool blackMatte;
out vec4 color;
float cubic(float x) {
  x = abs(x);
  if (x < 1.0) return (1.5*x-2.5)*x*x+1.0;
  if (x < 2.0) return ((-0.5*x+2.5)*x-4.0)*x+2.0;
  return 0.0;
}
void main() {
  vec2 p = vec2(gl_FragCoord.x, outputHeight-gl_FragCoord.y);
  vec2 uv = (p-destination.xy)/destination.zw;
  if (any(lessThan(uv,vec2(0))) || any(greaterThanEqual(uv,vec2(1)))) {color=vec4(0,0,0,1);return;}
  vec2 point = sourceRect.xy + uv*sourceRect.zw;
  vec4 sampleColor = vec4(0);
  if (mipLevel > 0.0) {
    sampleColor = textureLod(sourceImage, point/sourceSize, mipLevel);
  } else {
    vec2 base=floor(point-0.5), fraction=point-0.5-base;
    for(int y=-1;y<=2;++y) for(int x=-1;x<=2;++x) {
      vec2 pos=clamp(base+vec2(x,y)+0.5,sourceRect.xy+0.5,sourceRect.xy+sourceRect.zw-0.5);
      sampleColor+=textureLod(sourceImage,pos/sourceSize,0.0)*cubic(float(x)-fraction.x)*cubic(float(y)-fraction.y);
    }
  }
  float alpha=clamp(sampleColor.a,0.0,1.0);
  color=vec4(clamp(sampleColor.rgb,vec3(0),vec3(alpha)),blackMatte?1.0:alpha);
}`

function createRenderer() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    failIfMajorPerformanceCaveat: true,
  })
  if (!gl) throw Error('系统未提供硬件 WebGL 2')
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  const name = String(gl.getParameter(info?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER))
  const program = gl.createProgram()
  if (!program) throw Error('显卡程序创建失败')
  try {
    if (/swiftshader|llvmpipe|softpipe|software rasterizer|basic render driver/i.test(name))
      throw Error('系统正在使用软件渲染')
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type)
      if (!shader) throw Error('显卡着色器不可用')
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      gl.attachShader(program, shader)
      gl.deleteShader(shader)
    }
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error('当前驱动无法编译缩放着色器')
    return { canvas, gl, program, name }
  } catch (e) {
    gl.deleteProgram(program)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    throw e
  }
}

let renderer: ReturnType<typeof createRenderer> | undefined
let expire: ReturnType<typeof setTimeout> | undefined
function getRenderer() {
  if (!renderer || renderer.gl.isContextLost()) renderer = createRenderer()
  clearTimeout(expire)
  return renderer
}
function releaseLater() {
  clearTimeout(expire)
  expire = setTimeout(() => {
    renderer?.gl.getExtension('WEBGL_lose_context')?.loseContext()
    renderer = undefined
  }, 30_000)
}
export function graphicsDevice() {
  try {
    const r = getRenderer()
    return { available: true, label: r.name }
  } catch (e) {
    return { available: false, label: e instanceof Error ? e.message : String(e) }
  } finally {
    releaseLater()
  }
}

async function gpuPng(id: string, size: ExportSize) {
  const raw = await invoke<ArrayBuffer>('export_input', { id })
  const bitmap = await createImageBitmap(new Blob([raw]), {
    imageOrientation: 'from-image',
    premultiplyAlpha: 'premultiply',
  })
  let cropped: ImageBitmap | undefined
  try {
    const { gl, canvas, program } = getRenderer()
    const w = size.width,
      h = size.height,
      sw = bitmap.width,
      sh = bitmap.height
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    if (Math.max(w, h, sw, sh) > max || sw * sh > 50_000_000)
      throw Error('尺寸超过显卡可用纹理范围')
    const texture = gl.createTexture()
    try {
      canvas.width = w
      canvas.height = h
      if (gl.drawingBufferWidth !== w || gl.drawingBufferHeight !== h)
        throw Error('显卡无法分配目标画布')
      gl.viewport(0, 0, w, h)
      gl.useProgram(program)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      const contain = size.fit === 'contain'
      const scale = contain ? Math.min(w / sw, h / sh) : Math.max(w / sw, h / sh)
      const dw = contain ? Math.max(1, Math.round(sw * scale)) : w,
        dh = contain ? Math.max(1, Math.round(sh * scale)) : h
      const cw = contain ? sw : Math.min(sw, Math.max(1, Math.floor((sh * w) / h)))
      const ch = contain ? sh : Math.min(sh, Math.max(1, Math.floor((sw * h) / w)))
      const mip = Math.max(0, Math.log2(Math.max(cw / dw, ch / dh)))
      const left = Math.floor((sw - cw) / 2),
        top = Math.floor((sh - ch) / 2)
      // Isolate a reduced crop before generating mipmaps so excluded pixels never enter the filter.
      if (mip > 0 && (cw !== sw || ch !== sh))
        cropped = await createImageBitmap(bitmap, left, top, cw, ch, {
          premultiplyAlpha: 'premultiply',
        })
      const source = cropped ?? bitmap
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        mip > 0 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
      )
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      if (mip > 0) gl.generateMipmap(gl.TEXTURE_2D)
      const u = (name: string) => gl.getUniformLocation(program, name)
      gl.uniform4f(u('sourceRect'), cropped ? 0 : left, cropped ? 0 : top, cw, ch)
      gl.uniform4f(u('destination'), Math.floor((w - dw) / 2), Math.floor((h - dh) / 2), dw, dh)
      gl.uniform2f(u('sourceSize'), source.width, source.height)
      gl.uniform1f(u('outputHeight'), h)
      gl.uniform1f(u('mipLevel'), mip)
      gl.uniform1i(u('blackMatte'), contain ? 1 : 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) throw Error('显卡未能完成绘制')
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(Error('PNG 编码失败'))), 'image/png'),
      )
      if (gl.isContextLost()) throw Error('显卡设备已断开')
      return new Uint8Array(await blob.arrayBuffer())
    } finally {
      gl.deleteTexture(texture)
      canvas.width = canvas.height = 1
    }
  } finally {
    cropped?.close()
    bitmap.close()
    releaseLater()
  }
}

let gpuIdle = Promise.resolve()
export async function sizedExport(
  id: string,
  resize: ExportSize,
  chooseLocation: boolean,
  mode: PerformanceMode,
) {
  if (
    !Number.isInteger(resize.width) ||
    !Number.isInteger(resize.height) ||
    resize.width < 1 ||
    resize.height < 1 ||
    resize.width * resize.height > 50_000_000
  ) {
    throw Error('单张导出须为有效像素尺寸，最多 5000 万像素。')
  }
  let fallback = ''
  if (mode === 'performance') {
    const render = gpuIdle.then(() => gpuPng(id, resize))
    gpuIdle = render.then(
      () => {},
      () => {},
    )
    let png: Uint8Array | undefined
    try {
      png = await render
    } catch (e) {
      fallback = e instanceof Error ? e.message : String(e)
    }
    if (png) {
      // File selection and saving run once, after rendering or its CPU fallback has been decided.
      const path = await invoke<string | null>('export_rendered', png, {
        headers: {
          'x-job-id': id,
          'x-width': String(resize.width),
          'x-height': String(resize.height),
          'x-fit': resize.fit,
          'x-choose': chooseLocation ? '1' : '0',
        },
      })
      return { path, engine: 'GPU', fallback }
    }
  }
  const path = await invoke<string | null>('export_job', { id, resize, chooseLocation })
  return { path, engine: 'CPU', fallback }
}
