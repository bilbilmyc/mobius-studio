import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Modal } from './Editor'
interface Report {
  title: string
  scenes: string[]
  jobs: number
  drafts: number
  missing: string[]
  conflicts: number
  id: string | null
}
export function ProjectTransfer({
  scriptId,
  flush,
  imported,
}: {
  scriptId?: string
  flush: () => Promise<void>
  imported: (id: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false),
    [path, setPath] = useState(''),
    [report, setReport] = useState<Report>(),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  async function run(action: () => Promise<void>) {
    setBusy(true)
    setMessage('')
    try {
      await action()
    } catch (e) {
      setMessage(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button
        onClick={() => {
          setOpen(true)
          setReport(undefined)
          setMessage('')
        }}
      >
        项目备份与迁移
      </button>
      {open && (
        <Modal title="项目备份与迁移" close={() => setOpen(false)}>
          <div className="project-tools">
            {scriptId && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await flush()
                    const file = await invoke<string>('export_project', { id: scriptId })
                    setMessage('备份已保存至 ' + file)
                  })
                }
              >
                备份当前剧本
              </button>
            )}
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const p = await invoke<string | null>('pick_project')
                  if (!p) return
                  setReport(undefined)
                  setPath(p)
                  setReport(await invoke<Report>('import_project', { path: p, commit: false }))
                })
              }
            >
              选择项目备份
            </button>
            {report && (
              <>
                <h3>{report.title}</h3>
                <ol>
                  {report.scenes.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
                <p>
                  {report.jobs} 个作品 · {report.drafts} 份草稿 · {report.conflicts} 个同名项目
                </p>
                {report.missing.length > 0 && <p role="alert">缺少素材：{report.missing.join('、')}</p>}
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await flush()
                      const restored = await invoke<Report>('import_project', { path, commit: true })
                      await imported(restored.id!)
                      setOpen(false)
                    })
                  }
                >
                  导入为独立项目
                </button>
              </>
            )}
            {message && <p role="status">{message}</p>}
          </div>
        </Modal>
      )}
    </>
  )
}
