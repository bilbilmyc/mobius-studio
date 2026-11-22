import { useEffect, useMemo, useRef, useState } from 'react'
import { bash } from '../developer/bash'
import { python } from '../developer/python'
import { go } from '../developer/go'
import { languages, variables, type Language, type RequestExample, type RequestSummary } from '../developer/model'
import { Modal } from './Editor'
import './request-history.css'

export function DeveloperSettings({ enabled, reload }: { enabled: boolean; reload: () => Promise<void> }) {
  const [pending, setPending] = useState<boolean>(), [error, setError] = useState('')
  async function change(value: boolean) {
    setPending(value); setError('')
    try { await window.studio.setDeveloperMode(value); await reload() }
    catch (e) { setError(String(e)) }
    finally { setPending(undefined) }
  }
  return <>
    <div className="preference-row"><div><h3>请求记录与代码示例</h3>
      <p id="developer-mode-note">开启后，从窗口顶部的「请求记录」查看本次运行最近 80 条请求。关闭开关或退出应用会清空记录。</p></div>
      <label className="check-line dev-switch"><input type="checkbox" checked={pending ?? enabled} disabled={pending !== undefined}
        onChange={e => void change(e.target.checked)} aria-describedby="developer-mode-note"/>启用开发者模式</label>
    </div>
    {error && <p role="alert" className="error">{error}</p>}
  </>
}

const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const formatters = { 'Bash cURL': bash, Python: python, Go: go }
function outcome(r: RequestSummary) {
  if (r.status !== null) return 'HTTP ' + r.status
  return { pending: '发送中', failed: '连接失败', interrupted: '已中断', received: '已响应' }[r.outcome]
}
function endpoint(target: string) {
  try { const u = new URL(target); return u.pathname === '/%E2%80%A6' ? u.host + '/…' : u.pathname }
  catch { return target }
}
export function RequestHistory({ close }: { close: () => void }) {
  const [rows, setRows] = useState<RequestSummary[]>(), [chosen, choose] = useState<number>()
  const [error, setError] = useState(''), revision = useRef(0)
  useEffect(() => {
    let live = true, timer: number
    async function update() {
      const version = revision.current
      try {
        const list = await window.studio.requestHistory()
        if (live && version === revision.current) {
          setRows(list); setError('')
          choose(old => list.some(row => row.id === old) ? old : list[0]?.id)
        }
      } catch (e) { if (live) setError(String(e)) }
      if (live) timer = window.setTimeout(update, 900)
    }
    void update()
    return () => { live = false; window.clearTimeout(timer) }
  }, [])
  async function clear() {
    try {
      await window.studio.clearRequestHistory()
      revision.current++; setRows([]); choose(undefined); setError('')
    } catch (e) { setError(String(e)) }
  }
  const active = rows?.find(r => r.id === chosen)
  const [language, setLanguage] = useState<Language>('Bash cURL')
  return <Modal title="请求记录" close={close} wide>
    <div className="dev-history">
      <div className="dev-count"><span>{rows ? '本次运行 · ' + rows.length + ' / 80' : '正在读取请求…'}</span>
        <button disabled={!rows?.length} onClick={() => void clear()}>清空记录</button></div>
      {error && <p role="alert" className="error">{error}</p>}
      {rows?.length === 0 && <p className="dev-empty">还没有请求。试着获取模型列表，或发起一次创作。</p>}
      {!!rows?.length && <div className="dev-panes">
        <nav aria-label="已发送的请求" className="dev-list">{rows.map(r => <button key={r.id}
          aria-current={r.id === chosen ? 'true' : undefined} onClick={() => choose(r.id)}>
          <span><strong>{r.method}</strong> <time>{clock.format(r.time)}</time></span>
          <span className="dev-target" title={r.target}>{endpoint(r.target)}</span>
          <small>{outcome(r)}{r.elapsedMs !== null && ' · ' + r.elapsedMs + ' ms'}</small>
        </button>)}</nav>
        {active && <ExamplePanel key={active.id} row={active} language={language} setLanguage={setLanguage}/>}
      </div>}
    </div>
  </Modal>
}
function ExamplePanel({ row, language, setLanguage }: {
  row: RequestSummary; language: Language; setLanguage: (l: Language) => void
}) {
  const [example, setExample] = useState<RequestExample | null>(), [error, setError] = useState('')
  const [copied, setCopied] = useState<Language>()
  useEffect(() => {
    let live = true
    window.studio.requestExample(row.id).then(r => { if (live) setExample(r) }).catch(e => { if (live) setError(String(e)) })
    return () => { live = false }
  }, [row.id])
  const code = useMemo(() => example ? formatters[language](example) : '', [example, language])
  const inputs = useMemo(() => example ? [...variables(example)] : [], [example])
  async function copy() {
    try { await window.studio.copyRequestExample(row.id, code); setCopied(language); setError('') }
    catch (e) { setError(String(e)) }
  }
  return <section aria-label="请求代码示例" className="dev-detail">
    <div className="dev-address"><strong>{row.method}</strong> <code>{row.target}</code></div>
    <div className="dev-code-tools"><div className="segments" role="group" aria-label="示例语言">{languages.map(l =>
      <button key={l} aria-pressed={language === l} onClick={() => { setLanguage(l); setCopied(undefined) }}>{l}</button>)}</div>
      <button disabled={!code} onClick={() => void copy()}>复制代码</button></div>
    {code ? <pre tabIndex={0} aria-label={language + ' 代码'}><code>{code}</code></pre>
      : <p>{example === null ? '这条请求已移出记录。' : '正在读取示例…'}</p>}
    {!!inputs.length && <details className="dev-vars"><summary>运行前设置环境变量（{inputs.length}）</summary>
      <dl>{inputs.map(([name,hint]) => <div key={name}><dt><code>{name}</code></dt><dd>{hint}</dd></div>)}</dl></details>}
    <span role="status" className={error ? 'error' : 'help'}>{error || (copied === language ? '已复制 ' + language + ' 示例。' : '')}</span>
  </section>
}
