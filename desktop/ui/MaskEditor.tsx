import { useEffect, useRef, useState } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import type { Picked } from '../shared'
import { Modal } from './Editor'
export function MaskEditor({
  image,
  mask,
  save,
}: {
  image: Picked
  mask?: Picked
  save: (m?: Picked) => void
}) {
  const [open, show] = useState(false),
    [src, setSrc] = useState(''),
    [brush, setBrush] = useState(40),
    [error, say] = useState(''),
    [busy, lock] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null),
    last = useRef<[number, number] | undefined>(undefined)
  useEffect(() => {
    if (!open) return
    let alive = true
    void window.studio
      .preview(image)
      .then((p) => {
        if (!p) throw Error('请先选择可预览的本地底图。')
        if (alive) setSrc(convertFileSrc(p))
      })
      .catch((e) => say(String(e)))
    return () => {
      alive = false
    }
  }, [open, image.token])
  function paint(e: React.PointerEvent<HTMLCanvasElement>, start: boolean) {
    const c = e.currentTarget
    if (!start && !c.hasPointerCapture(e.pointerId)) return
    if (start) {
      c.setPointerCapture(e.pointerId)
      last.current = undefined
    }
    const r = c.getBoundingClientRect(),
      x = ((e.clientX - r.left) * c.width) / r.width,
      y = ((e.clientY - r.top) * c.height) / r.height,
      ctx = c.getContext('2d')!
    ctx.strokeStyle = '#ff4150'
    ctx.fillStyle = '#ff4150'
    ctx.lineCap = 'round'
    ctx.lineWidth = brush
    ctx.beginPath()
    if (last.current) {
      ctx.moveTo(...last.current)
      ctx.lineTo(x, y)
      ctx.stroke()
    } else {
      ctx.arc(x, y, brush / 2, 0, Math.PI * 2)
      ctx.fill()
    }
    last.current = [x, y]
  }
  async function commit() {
    const c = canvas.current
    if (!c) return
    lock(true)
    try {
      const output = document.createElement('canvas')
      output.width = c.width
      output.height = c.height
      const ctx = output.getContext('2d')!
      ctx.fillStyle = 'white'
      ctx.fillRect(0, 0, c.width, c.height)
      ctx.globalCompositeOperation = 'destination-out'
      ctx.drawImage(c, 0, 0)
      const blob = await new Promise<Blob>((resolve, reject) =>
        output.toBlob((b) => (b ? resolve(b) : reject(Error('无法生成遮罩。'))), 'image/png')
      )
      save(await invoke<Picked>('save_mask', new Uint8Array(await blob.arrayBuffer())))
      show(false)
    } catch (e) {
      say(String(e))
    } finally {
      lock(false)
    }
  }
  return (
    <>
      <button
        onClick={() => {
          setSrc('')
          say('')
          show(true)
        }}
      >
        {mask ? '重画局部遮罩' : '绘制局部遮罩'}
      </button>
      {mask && <button onClick={() => save()}>移除遮罩</button>}
      {open && (
        <Modal wide title="绘制局部遮罩" close={() => show(false)}>
          <div className="project-tools">
            <p>在底图上涂出需要重新生成的区域。</p>
            <label>
              画笔像素
              <input
                type="range"
                min="2"
                max="240"
                value={brush}
                onChange={(e) => setBrush(+e.target.value)}
              />
            </label>
            {src && (
              <div className="mask-paint">
                <img
                  alt="局部重绘底图"
                  src={src}
                  onLoad={(e) => {
                    const im = e.currentTarget,
                      c = canvas.current
                    if (!c) return
                    if (im.naturalWidth * im.naturalHeight > 32e6) {
                      say('底图超过 3200 万像素。')
                      return
                    }
                    c.width = im.naturalWidth
                    c.height = im.naturalHeight
                  }}
                />
                <canvas
                  ref={canvas}
                  aria-label="涂抹重绘区域"
                  onPointerDown={(e) => paint(e, true)}
                  onPointerMove={(e) => paint(e, false)}
                  onPointerUp={(e) => {
                    e.currentTarget.releasePointerCapture(e.pointerId)
                    last.current = undefined
                  }}
                />
              </div>
            )}
            <button
              onClick={() => {
                const c = canvas.current
                c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
              }}
            >
              清空涂选
            </button>
            <label>
              或选择同尺寸的透明 PNG 遮罩
              <button
                onClick={() =>
                  void window.studio
                    .pick('image', false)
                    .then((p) => {
                      if (p[0]) {
                        save(p[0])
                        show(false)
                      }
                    })
                    .catch((e) => say(String(e)))
                }
              >
                选择遮罩文件
              </button>
            </label>
            <button disabled={busy || !src || !!error} onClick={() => void commit()}>
              使用涂选区域
            </button>
            {error && <p role="alert">{error}</p>}
          </div>
        </Modal>
      )}
    </>
  )
}
