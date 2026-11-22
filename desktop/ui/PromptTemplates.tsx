import { TemplateEditor, TemplatePreview, mediaLabels } from './templates/TemplateForms'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MediaKind } from '../shared'
import {
  matchScore,
  type TemplateChange,
  type TemplateLibrary,
  type TemplateMedium,
  type TemplateSpec,
} from '../agent/templates'
import { Modal } from './Editor'

interface Props {
  kind: MediaKind
  seed: string
  applyLabel: string
  apply: (text: string, name: string) => void
  maxLength?: number
  disabled?: boolean
}

const blank = (body: string, medium: TemplateMedium): TemplateSpec => ({
  name: '',
  description: '',
  body,
  medium,
})
const fieldsOf = (e: TemplateSpec): TemplateSpec => ({
  name: e.name,
  author: e.author,
  source: e.source,
  description: e.description,
  medium: e.medium,
  body: e.body,
})

export function PromptTemplates(props: Props) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="link" disabled={props.disabled} onClick={() => setOpen(true)}>
        提示词模板
      </button>
      {open && createPortal(<TemplateDialog {...props} close={() => setOpen(false)} />, document.body)}
    </>
  )
}

function TemplateDialog({
  kind,
  seed,
  apply,
  applyLabel,
  maxLength = 12000,
  close,
}: Props & { close: () => void }) {
  const [library, setLibrary] = useState<TemplateLibrary | null>(null)
  const [selected, select] = useState('')
  const [query, search] = useState('')
  const [allMedia, setAllMedia] = useState(false)
  const [edit, setEdit] = useState<{ id?: string; draft: TemplateSpec } | null>(null)
  const [incoming, setIncoming] = useState<{
    templates: TemplateSpec[]
    skipped: number
    index: number
  } | null>(null)
  const [removing, remove] = useState(false)
  const [status, report] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reload, refresh] = useState(0)
  const lock = useRef(false)
  const finder = useRef<HTMLInputElement>(null)
  const file = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let alive = true
    setLibrary(null)
    setError('')
    window.studio
      .promptTemplates()
      .then((data) => {
        if (alive) setLibrary(data)
      })
      .catch((e) => {
        if (alive) setError(String(e))
      })
    return () => {
      alive = false
    }
  }, [reload])
  const visible = (library?.entries ?? []).filter(
    (e) =>
      (allMedia || e.medium === 'any' || e.medium === kind) &&
      matchScore(query, [e.name, e.description, e.body])
  )
  const current = visible.find((e) => e.id === selected) ?? visible[0]
  const custom = current && !current.id.startsWith('builtin-')
  function choose(id: string) {
    select(id)
    setEdit(null)
    remove(false)
  }
  async function operation(action: () => Promise<void>) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    report('')
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  function change(value: TemplateChange) {
    if (!library) return
    void operation(async () => {
      const result = await window.studio.changePromptTemplates(library.revision, value)
      setLibrary(result.library)
      setIncoming(null)
      setEdit(null)
      remove(false)
      if (result.selected) {
        search('')
        setAllMedia(true)
        select(result.selected)
      }
      if (value.action === 'import')
        report(
          '已添加 ' +
            result.added +
            ' 个模板' +
            (result.skipped ? '，跳过 ' + result.skipped + ' 个重复项' : '') +
            (result.renamed ? '，' + result.renamed + ' 个同名模板已另存' : '') +
            '。'
        )
      else report(value.action === 'edit' ? '模板已保存。' : '模板已移除。')
    })
  }
  function exportPack(ids: string[], chooseLocation: boolean) {
    void operation(async () => {
      const path = await window.studio.exportPromptTemplates(ids, chooseLocation)
      if (path) report('已导出到 ' + path)
    })
  }
  function importFile(f: File) {
    void operation(async () => {
      if (f.size > 16 * 1024 * 1024) throw Error('请选择小于 16 MB 的模板文件。')
      const parsed = await window.studio.parsePromptTemplates(f.name, await f.text())
      setIncoming({ ...parsed, index: 0 })
      setEdit(null)
      remove(false)
    })
  }
  const entry = incoming?.templates[incoming.index]
  return (
    <Modal title="提示词模板" wide close={close} initialFocus={finder}>
      <div className="dialog-body template-library">
        <div className="template-search">
          <input
            ref={finder}
            aria-label="查找模板"
            type="search"
            placeholder="搜索名称或提示词"
            value={query}
            onChange={(e) => {
              search(e.target.value)
              setEdit(null)
              remove(false)
            }}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={allMedia}
              onChange={(e) => {
                setAllMedia(e.target.checked)
                setEdit(null)
                remove(false)
              }}
            />
            全部媒体
          </label>
        </div>
        {visible.length > 0 ? (
          <>
            <label>
              选择模板
              <select aria-label="选择模板" value={current.id} onChange={(e) => choose(e.target.value)}>
                {visible.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} · {mediaLabels[e.medium]}
                  </option>
                ))}
              </select>
            </label>
            <TemplatePreview
              key={current.id + ':' + library?.revision}
              entry={current}
              maxLength={maxLength}
              applyLabel={applyLabel}
              apply={(text) => {
                apply(text, current.name)
                close()
              }}
              disabled={busy}
            />
          </>
        ) : (
          <p>{library ? '没有匹配的模板。' : '正在读取模板…'}</p>
        )}
        <details className="template-manage">
          <summary>管理与分享</summary>
          <div className="template-actions">
            <button
              disabled={busy || !library}
              onClick={() => {
                setEdit({ draft: blank(seed, kind) })
                setIncoming(null)
                remove(false)
              }}
            >
              新建模板
            </button>
            <button disabled={busy || !library} onClick={() => file.current?.click()}>
              导入文件
            </button>
            {current && (
              <button disabled={busy} onClick={() => exportPack([current.id], false)}>
                导出当前模板
              </button>
            )}
            {!!library?.entries.length && (
              <button
                disabled={busy}
                onClick={() =>
                  exportPack(
                    library.entries.map((e) => e.id),
                    true
                  )
                }
              >
                模板库另存为
              </button>
            )}
            <input
              hidden
              type="file"
              ref={file}
              aria-label="模板文件"
              accept=".json,.md,.markdown,.txt,.csv"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) importFile(f)
              }}
            />
          </div>
          {current && (
            <div className="template-actions">
              <button
                className="link"
                disabled={busy}
                onClick={() => {
                  setEdit({
                    id: custom ? current.id : undefined,
                    draft: {
                      ...fieldsOf(current),
                      name: custom ? current.name : current.name + ' 副本',
                    },
                  })
                  setIncoming(null)
                  remove(false)
                }}
              >
                {custom ? '编辑当前模板' : '从内置模板创建副本'}
              </button>
              {custom &&
                (removing ? (
                  <>
                    <button disabled={busy} onClick={() => change({ action: 'remove', id: current.id })}>
                      确认移除
                    </button>
                    <button onClick={() => remove(false)}>取消移除</button>
                  </>
                ) : (
                  <button className="link" disabled={busy} onClick={() => remove(true)}>
                    移除当前模板
                  </button>
                ))}
            </div>
          )}
          {edit && (
            <TemplateEditor
              draft={edit.draft}
              change={(draft) => setEdit({ ...edit, draft })}
              disabled={busy}
              cancel={() => setEdit(null)}
              save={() =>
                change(
                  edit.id
                    ? { action: 'edit', id: edit.id, template: edit.draft }
                    : { action: 'import', templates: [edit.draft] }
                )
              }
            />
          )}
          {incoming && entry && (
            <section className="template-import">
              <strong>导入预览 · {incoming.templates.length} 个模板</strong>
              {incoming.skipped > 0 && (
                <small>已略过 {incoming.skipped} 个缺少有效名称或正文的条目。</small>
              )}
              <select
                aria-label="预览待导入模板"
                value={incoming.index}
                onChange={(e) => setIncoming({ ...incoming, index: Number(e.target.value) })}
              >
                {incoming.templates.map((t, i) => (
                  <option key={i} value={i}>
                    {t.name} · {mediaLabels[t.medium]}
                  </option>
                ))}
              </select>
              <pre>{entry.body}</pre>
              <div className="template-actions">
                <button disabled={busy} onClick={() => change({ action: 'import', templates: [entry] })}>
                  导入此模板
                </button>
                {incoming.templates.length > 1 && (
                  <button
                    disabled={busy}
                    onClick={() => change({ action: 'import', templates: incoming.templates })}
                  >
                    导入全部 {incoming.templates.length} 项
                  </button>
                )}
                <button disabled={busy} onClick={() => setIncoming(null)}>
                  取消导入
                </button>
              </div>
            </section>
          )}
        </details>
        {status && <small role="status">{status}</small>}
        {error && (
          <p className="form-error" role="alert">
            {error}{' '}
            <button className="link" onClick={() => refresh((x) => x + 1)}>
              重新读取模板库
            </button>
          </p>
        )}
      </div>
      <footer className="modal-actions">
        <button onClick={close}>返回</button>
      </footer>
    </Modal>
  )
}
