import { useEffect, useRef, useState } from 'react'
import { Modal } from './Editor'
import type { JobView } from '../shared'
import { aspect, fitSize, requestedGeometry } from './outputSpecs'
import { isGif } from './gifInfo'
export function ImageExport({
  job,
  url,
  w,
  h,
  close,
  saved,
}: {
  job: JobView
  url: string
  w: number
  h: number
  close: () => void
  saved: (s: string, engine: string, fallback: string) => void
}) {
  const request = requestedGeometry(job)
  const gif = isGif(job)
  const [format, setFormat] = useState<'gif' | 'png'>(gif ? 'gif' : 'png')
  const still = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = still.current
    if (!canvas) return
    const source = new Image()
    source.onload = () => {
      const scale = Math.min(1, 600 / Math.max(source.naturalWidth, source.naturalHeight))
      canvas.width = Math.max(1, Math.round(source.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(source.naturalHeight * scale))
      canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height)
    }
    source.src = url
    return () => { source.onload = null }
  }, [url, format])
  const initial = request?.ratio ?? aspect(w, h)
  const dimensions = (r: string) => r === request?.ratio && request.pixels ? request.pixels : fitSize(w, h, r)
  const [[width, height], size] = useState(() => dimensions(initial)),
    [ratio, setRatio] = useState(initial),
    [fit, setFit] = useState<'crop' | 'contain'>('crop'),
    [busy, setBusy] = useState(false),
    [error, fail] = useState('')
  async function write(choose: boolean) {
    if (busy) return
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > 50_000_000
    ) {
      fail('请填写有效的宽和高，单张上限为 5000 万像素。')
      return
    }
    setBusy(true)
    fail('')
    try {
      const result = await window.studio.exportSized(
        job.id,
        { width, height, fit, format },
        choose,
      )
      if (result.path) {
        saved(result.path, result.engine, result.fallback)
        close()
      }
    } catch (e) {
      fail(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title="按尺寸导出图片"
      close={() => {
        if (!busy) close()
      }}
    >
      <div className="dialog-body fields">
        <div className="export-preview">
          <div
            style={{
              aspectRatio:
                width > 0 && height > 0 ? String(width / height) : '1',
              maxWidth: '100%',
              width:
                'min(100%, ' + (190 * (width || 1)) / (height || 1) + 'px)',
            }}
          >
            {gif && format === 'png' ? <canvas ref={still} role="img" aria-label="首帧导出构图预览"
              style={{ width: '100%', height: '100%', objectFit: fit === 'crop' ? 'cover' : 'contain' }} /> : <img
              src={url}
              alt="导出构图预览"
              style={{ objectFit: fit === 'crop' ? 'cover' : 'contain' }}
            />}
          </div>
        </div>
        <small>
          原图 {w} × {h} · {aspect(w, h)}　输出 {format.toUpperCase()}
        </small>
        {gif && <label>导出格式
          <select value={format} onChange={e => setFormat(e.target.value as 'gif' | 'png')}>
            <option value="gif">GIF 动图（保留帧间隔与循环）</option>
            <option value="png">导出首帧 PNG</option>
          </select>
        </label>}
        <label>
          导出画幅
          <select
            aria-label="导出画幅"
            value={ratio}
            onChange={(e) => {
              const r = e.target.value
              setRatio(r)
              if (r !== 'custom') size(dimensions(r))
            }}
          >
            {[
              ...new Set([
                initial,
                aspect(w, h),
                '16:9',
                '9:16',
                '1:1',
                '4:3',
                '3:2',
              ]),
            ].map((r) => (
              <option key={r}>{r}</option>
            ))}
            <option value="custom">自定义</option>
          </select>
        </label>
        <div className="two">
          <label>
            宽度（像素）
            <input
              type="number"
              min="1"
              value={width || ''}
              onChange={(e) => {
                setRatio('custom')
                size([Number(e.target.value), height])
              }}
            />
          </label>
          <label>
            高度（像素）
            <input
              type="number"
              min="1"
              value={height || ''}
              onChange={(e) => {
                setRatio('custom')
                size([width, Number(e.target.value)])
              }}
            />
          </label>
        </div>
        <label>
          适配方式
          <select
            aria-label="适配方式"
            value={fit}
            onChange={(e) => setFit(e.target.value as 'crop' | 'contain')}
          >
            <option value="crop">居中裁切，铺满画面</option>
            <option value="contain">完整保留画面，空白处填黑</option>
          </select>
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="modal-actions">
        <button disabled={busy} onClick={() => void write(true)}>
          另选位置…
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void write(false)}
        >
          {busy ? '导出中…' : '导出到作品目录'}
        </button>
      </footer>
    </Modal>
  )
}
