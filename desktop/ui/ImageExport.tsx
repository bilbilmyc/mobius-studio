import { useState } from 'react'
import { Modal } from './Editor'
import type { JobView } from '../shared'
export function aspect(width: number, height: number) {
  let a = width,
    b = height
  while (b) {
    ;[a, b] = [b, a % b]
  }
  return a ? width / a + ':' + height / a : ''
}
function fitSize(w: number, h: number, ratio: string) {
  const [x, y] = ratio.split(':').map(Number)
  if (!x || !y) return [w, h]
  return w / h > x / y
    ? [Math.max(1, Math.round((h * x) / y)), h]
    : [w, Math.max(1, Math.round((w * y) / x))]
}
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
  saved: (s: string) => void
}) {
  const initial = job.size.includes(':') ? job.size : aspect(w, h)
  const [[width, height], size] = useState(() => fitSize(w, h, initial)),
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
      const path = await window.studio.exportFile(
        job.id,
        { width, height, fit },
        choose,
      )
      if (path) {
        saved(path)
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
            <img
              src={url}
              alt="导出构图预览"
              style={{ objectFit: fit === 'crop' ? 'cover' : 'contain' }}
            />
          </div>
        </div>
        <small>
          原图 {w} × {h} · {aspect(w, h)}　输出 PNG
        </small>
        <label>
          导出画幅
          <select
            aria-label="导出画幅"
            value={ratio}
            onChange={(e) => {
              const r = e.target.value
              setRatio(r)
              if (r !== 'custom') size(fitSize(w, h, r))
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
