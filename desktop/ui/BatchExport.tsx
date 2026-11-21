import { useRef, useState } from 'react'
import { type JobView, type PerformanceMode, type ExportSize } from '../shared'
import { Modal } from './Editor'
import { sizedExport } from './gpuExport'
import { paginate, PageControls } from './LibraryPages'

export function BatchExport({
  jobs,
  mode,
  close,
}: {
  jobs: JobView[]
  mode: PerformanceMode
  close: () => void
}) {
  const [items] = useState(() =>
    jobs.filter((j) => j.file && j.kind === 'image' && j.status === 'done'),
  )
  const [selected, setSelected] = useState(() => new Set(items.map((j) => j.id)))
  const [page, setPage] = useState(1)
  const choices = paginate(items, page)
  const [size, setSize] = useState<ExportSize>({ width: 1920, height: 1080, fit: 'contain' })
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [errors, setErrors] = useState<string[]>([])
  const stop = useRef(false)
  async function run() {
    if (!selected.size || busy) return
    setBusy(true)
    stop.current = false
    setErrors([])
    let count = 0,
      gpu = 0,
      cpu = 0
    try {
      for (const j of items) {
        if (stop.current) break
        if (!selected.has(j.id)) continue
        setMessage(`正在导出 ${++count} / ${selected.size}`)
        try {
          const result = await sizedExport(j.id, size, false, mode)
          if (result.path) {
            if (result.engine === 'GPU') gpu++
            else cpu++
          }
        } catch (e) {
          setErrors((prev) => [...prev, (j.prompt || j.model) + ' · ' + String(e)])
        }
      }
      setMessage(
        `${stop.current ? '已停止' : '批量导出完成'} · 已保存 ${gpu + cpu} 张至作品目录的「导出」文件夹（GPU ${gpu}，CPU ${cpu}）`,
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title="批量导出图片"
      close={() => {
        if (!busy) close()
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void run()
        }}
      >
        <div className="dialog-body fields">
          <fieldset className="storage-fields" disabled={busy}>
            <div className="two">
              <label>
                宽度（像素）
                <input
                  type="number"
                  min={1}
                  required
                  value={size.width || ''}
                  onChange={(e) => setSize({ ...size, width: +e.target.value })}
                />
              </label>
              <label>
                高度（像素）
                <input
                  type="number"
                  min={1}
                  required
                  value={size.height || ''}
                  onChange={(e) => setSize({ ...size, height: +e.target.value })}
                />
              </label>
            </div>
            <label>
              适配方式
              <select
                value={size.fit}
                onChange={(e) => setSize({ ...size, fit: e.target.value as ExportSize['fit'] })}
              >
                <option value="contain">完整保留画面，空白处填黑</option>
                <option value="crop">居中裁切，铺满画面</option>
              </select>
            </label>
            <label className="check-line">
              <input
                type="checkbox"
                ref={(el) => {
                  if (el) el.indeterminate = selected.size > 0 && selected.size < items.length
                }}
                checked={!!items.length && selected.size === items.length}
                onChange={(e) =>
                  setSelected(new Set(e.target.checked ? items.map((j) => j.id) : []))
                }
              />
              全选当前搜索结果（{items.length} 张图片）
            </label>
            <div className="batch-list" key={page}>
              {choices.items.map((j) => (
                <label key={j.id} className="check-line">
                  <input
                    type="checkbox"
                    checked={selected.has(j.id)}
                    onChange={(e) => {
                      const next = new Set(selected)
                      if (e.target.checked) next.add(j.id)
                      else next.delete(j.id)
                      setSelected(next)
                    }}
                  />
                  <span>{j.prompt || j.model}</span>
                </label>
              ))}
            </div>
            <PageControls page={page} pages={choices.pages} label="批量选择分页" change={setPage} />
          </fieldset>
          {size.width * size.height > 50_000_000 && (
            <span className="error">每张图片最多 5000 万像素。</span>
          )}
          <div role="status">{message}</div>
          {errors.length > 0 && (
            <details open>
              <summary>{errors.length} 张导出失败</summary>
              {errors.map((e, i) => (
                <p key={i} className="error">
                  {e}
                </p>
              ))}
            </details>
          )}
        </div>
        <footer className="modal-actions">
          {busy ? (
            <button
              type="button"
              onClick={() => {
                stop.current = true
                setMessage('正在完成当前图片…')
              }}
            >
              完成当前图片后停止
            </button>
          ) : (
            <button type="button" onClick={close}>
              关闭
            </button>
          )}
          <button
            className="primary"
            disabled={busy || !selected.size || size.width * size.height > 50_000_000}
          >
            导出 {selected.size} 张
          </button>
        </footer>
      </form>
    </Modal>
  )
}
