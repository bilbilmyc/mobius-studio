import { useEffect, useMemo, useState } from 'react'
import { statusLabels, siteTemplate, type Comparison, type Integrations, type JobView, type MediaKind, type Scene, type Script, type ShotLink } from '../shared'
import { ScriptEditor } from './ScriptEditor'
import { ServiceError } from './UsageHelp'

interface Props {
  active: boolean
  writer?: Integrations['writer']
  configure: () => void
  usePrompt: (kind: MediaKind, prompt: string, shot: ShotLink) => void
  jobs: JobView[]
  inspect: (job: JobView) => void
  useFrame: (image: JobView, motion: string) => Promise<void>
  revision: number
  comparisons: Comparison[]
  compare: (group: Comparison) => void
  beforeEdit: () => Promise<void>
  edited: (script: Script) => void
}

export function ScriptDesk({ active, writer, configure, usePrompt, jobs, inspect, useFrame, revision, comparisons, compare, beforeEdit, edited }: Props) {
  const [scripts, setScripts] = useState<Script[]>([]), [selected, select] = useState('')
  const [brief, setBrief] = useState(''), [count, setCount] = useState(4)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [writerError, setWriterError] = useState('')
  const [editing, edit] = useState<Script | 'new' | null>(null)
  const script = scripts.find(s => s.id === selected)
  const takesByScene = useMemo(() => {
    const result = new Map<string, JobView[]>()
    for (const job of jobs) {
      if (!job.shot || job.shot.scriptId !== selected) continue
      const takes = result.get(job.shot.sceneId)
      if (takes) takes.push(job)
      else result.set(job.shot.sceneId, [job])
    }
    return result
  }, [jobs, selected])
  const groupsByFirstJob = useMemo(() => new Map(comparisons.map(g => [g.jobIds[0], g])), [comparisons])
  const [marking, setMarking] = useState(false)
  async function mark(scene: Scene, job: JobView, remove: boolean) {
    if (!script || marking) return
    setMarking(true); setError('')
    try { const saved = await window.studio.setFinal(script.id, scene.id, job.kind, remove ? null : job.id)
      setScripts(all => all.map(s => s.id === saved.id ? saved : s))
    } catch (e) { setError(String(e)) } finally { setMarking(false) }
  }
  useEffect(() => {
    let current = true
    window.studio.scripts().then(all => {
      if (current) { setScripts(all); select(old => all.some(s => s.id === old) ? old : all[0]?.id ?? '') }
    }).catch(e => { if (current) setError(String(e)) })
    return () => { current = false }
  }, [revision])
  function remember(saved: Script) {
    setScripts(all => [saved, ...all.filter(s => s.id !== saved.id)].sort((a, b) => b.created - a.created))
    select(saved.id)
  }
  async function generate() {
    if (!writer?.hasKey) { configure(); return }
    setError(''); setWriterError(''); setBusy(true)
    try { remember(await window.studio.generateScript(brief, count)) }
    catch (e) { setWriterError(String(e)) }
    finally { setBusy(false) }
  }
  return <section className="script-desk page-body" hidden={!active} aria-label="剧本工作台">
    <aside className="writing-sidebar">
      <form className="writing-form" onSubmit={e => { e.preventDefault(); void generate() }}>
        <h2>新建剧本</h2>
        <button type="button" onClick={() => edit('new')}>手写或粘贴分镜</button>
        <label>故事构想<textarea rows={5} maxLength={12000} required={!!writer?.hasKey} value={brief}
          placeholder="主角是谁？故事在哪里发生？你想让观众记住什么？" onChange={e => setBrief(e.target.value)} /></label>
        <label>分镜数量<select value={count} onChange={e => setCount(+e.target.value)}>
          {[1, 2, 3, 4, 6, 8, 12].map(n => <option key={n} value={n}>{n} 个分镜</option>)}</select></label>
        <button className="primary" disabled={busy || !writer}>{busy ? '正在编写分镜…' : writer?.hasKey ? '生成剧本' : '配置剧本模型'}</button>
        {writer && <small>{writer.hasKey ? writer.model : '自动生成分镜需要文本模型，也可以在上方手写或粘贴。'}</small>}
        {writerError && <ServiceError message={writerError} context="writer" configure={configure} />}
      </form>
      <div className="script-history"><h2>我的剧本</h2>
        {scripts.map(s => <button key={s.id} aria-current={s.id === selected ? 'true' : undefined} onClick={() => select(s.id)}>
          <b>{s.title}</b><small>{s.scenes.length} 镜 · {new Date(s.created).toLocaleDateString()}</small></button>)}
        {!scripts.length && <p>生成后会自动保存到这里。</p>}
      </div>
    </aside>
    <div className="manuscript">
      {error && <p className="form-error" role="alert">{error}</p>}
      {busy && <p role="status" className="writing-progress">模型正在编写 {count} 个分镜，可切换到创作台继续工作。</p>}
      {script ? <>
        <div className="manuscript-title"><div><small>{script.scenes.length} 个分镜 · {script.model}</small>
          <h2>{script.title}</h2></div><button onClick={() => edit(script)}>编辑剧本</button></div>
        {script.brief && <p className="story-brief">{script.brief}</p>}
        <ol className="shot-list">
          {script.scenes.map((scene, index) => {
            const link = {scriptId: script.id, sceneId: scene.id, label: `${script.title} · 第 ${index + 1} 镜`}
            const takes = takesByScene.get(scene.id) ?? []
            const finals = script.finals[scene.id] ?? {}
            const first = takes.find(j => j.id === finals.image && j.file)
            return <li key={scene.id}>
            <span className="shot-number" aria-label={`分镜 ${index + 1}`}>{String(index + 1).padStart(2, '0')}</span>
            <article><h3>{scene.heading}</h3><p>{scene.action}</p>
              {scene.dialogue && <blockquote>{scene.dialogue}</blockquote>}
              <details><summary>分镜提示词</summary><dl><dt>图片</dt><dd>{scene.imagePrompt}</dd><dt>视频</dt><dd>{scene.videoPrompt}</dd></dl></details>
              <div className="shot-actions">
                <button onClick={() => usePrompt('image', scene.imagePrompt, link)}>用于生图</button>
                <button onClick={() => usePrompt('video', scene.videoPrompt, link)}>用于视频</button>
                {takes.flatMap(j => groupsByFirstJob.get(j.id) ?? []).map((g, i) =>
                  <button key={g.id} onClick={() => compare(g)}>双模型对比 {i + 1}</button>)}
                {first && <button onClick={() => void useFrame(first, scene.videoPrompt).catch(e => setError(String(e)))}>用定稿图生视频</button>}
              </div>
              {!!takes.length && <details className="shot-takes"><summary>关联作品 · {takes.length} 个版本</summary>
                <ul>{takes.map((j, n) => <li key={j.id}>
                  <button className="take-open" onClick={() => inspect(j)}>{j.kind === 'image' ? '图片' : '视频'} · {siteTemplate(j.model)?.Name ?? j.model}
                    <small>版本 {takes.length - n} · {statusLabels[j.status] ?? j.status}</small></button>
                  {j.status === 'done' && j.file && <button disabled={marking} aria-pressed={finals[j.kind] === j.id}
                    onClick={() => void mark(scene, j, finals[j.kind] === j.id)}>{finals[j.kind] === j.id ? '已定稿' : '设为定稿'}</button>}
                </li>)}</ul></details>}
            </article>
          </li>})}
        </ol>
      </> : !busy && <div className="script-empty"><h2>写下你的第一个分镜</h2><p>从故事构想开始，生成场景、动作、台词，以及每个镜头的图片和视频提示词。</p></div>}
    </div>
    {editing && <ScriptEditor initial={editing === 'new' ? undefined : editing} beforeSave={beforeEdit}
      close={() => edit(null)} saved={s => { remember(s); edited(s); edit(null) }} />}
  </section>
}
