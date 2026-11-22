import { useEffect, useMemo, useRef, useState } from 'react'
import { statusLabels, siteTemplate, writerName, type Comparison, type Integrations, type JobView, type MediaKind, type Scene, type Script, type ScriptRun, type ShotLink } from '../shared'
import { WriterSelector, type WriterSelection } from './WriterConnections'
import { ExpandableText } from './Editor'
import { FilmPreview, type NextFrame } from './FilmPreview'
import { ProjectTransfer } from './ProjectTransfer'
import { ShotBatch } from './ShotBatch'
import { ScriptEditor } from './ScriptEditor'
import { ScriptRunView } from './ScriptRunView'
import { ServiceError } from './UsageHelp'

interface Props extends WriterSelection {
  active: boolean
  runs: ScriptRun[]
  viewedRun: ScriptRun | null
  viewRun: (run: ScriptRun | null) => void
  integrations?: Integrations
  configure: () => void
  usePrompt: (kind: MediaKind, prompt: string, shot: ShotLink) => void
  jobs: JobView[]
  inspect: (job: JobView) => void
  useFrame: NextFrame
  imported: () => Promise<void>
  revision: number
  comparisons: Comparison[]
  compare: (group: Comparison) => void
  beforeEdit: () => Promise<void>
  edited: (script: Script) => void
}

export function ScriptDesk({ active, runs, viewedRun, viewRun, integrations, selectWriter, switchingWriter, configure, usePrompt, jobs, inspect, useFrame, revision, comparisons, compare, beforeEdit, edited, imported }: Props) {
  const writer = integrations?.writer
  const canChooseWriter = integrations && (integrations.writers.length > 1 || integrations.writer.models.length > 1)
  const [scripts, setScripts] = useState<Script[]>([]), [selected, select] = useState<string | null>(null)
  const [toolsOpen, setToolsOpen] = useState(false)
  const desk = useRef<HTMLElement>(null)
  const toolsButton = useRef<HTMLButtonElement>(null)
  const [brief, setBrief] = useState(''), [count, setCount] = useState(4)
  const [submitting, setSubmitting] = useState(false), [error, setError] = useState('')
  const submitLock = useRef(false)
  const draftRun = useRef('')
  const [writerError, setWriterError] = useState('')
  const [editing, edit] = useState<Script | 'new' | null>(null)
  const [batch,setBatch] = useState(false), [film,setFilm]=useState(false)
  const savedRunId = viewedRun?.status === 'done' ? viewedRun.id : undefined
  const displayedId = savedRunId ?? selected
  const script = (!viewedRun || savedRunId) ? scripts.find(s => s.id === displayedId) : undefined
  const busy = submitting || viewedRun?.status === 'writing'
  const canCollapse = !!script || !!viewedRun
  const viewedId = viewedRun?.id
  useEffect(() => {
    if (viewedId) { setToolsOpen(false); desk.current?.scrollTo({ top: 0 }) }
  }, [viewedId])
  const { writingRuns, savedCount } = useMemo(() => ({
    writingRuns: runs.filter(run => run.status === 'writing'),
    savedCount: runs.filter(run => run.status === 'done').length,
  }), [runs])
  const takesByScene = useMemo(() => {
    const result = new Map<string, JobView[]>()
    for (const job of jobs) {
      if (!job.shot || job.shot.scriptId !== displayedId) continue
      const takes = result.get(job.shot.sceneId)
      if (takes) takes.push(job)
      else result.set(job.shot.sceneId, [job])
    }
    return result
  }, [jobs, displayedId])
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
      if (current) {
        setScripts(all)
        select(old => old === null ? all[0]?.id ?? '' : all.some(s => s.id === old) ? old : '')
        if (savedRunId && !all.some(s => s.id === savedRunId)) setError('这份剧本文件已移出当前数据目录。')
      }
    }).catch(e => { if (current) setError(String(e)) })
    return () => { current = false }
  }, [revision, savedCount, savedRunId])
  function openScript(id: string) {
    viewRun(null)
    setError('')
    select(id)
    setToolsOpen(false)
    requestAnimationFrame(() => toolsButton.current?.focus())
  }
  function remember(saved: Script) {
    setScripts(all => [saved, ...all.filter(s => s.id !== saved.id)].sort((a, b) => b.created - a.created))
    openScript(saved.id)
  }
  async function generate() {
    if (busy || submitLock.current || switchingWriter) return
    if (!writer?.hasKey) { configure(); return }
    submitLock.current = true
    setError(''); setWriterError(''); setSubmitting(true)
    try {
      const { id, model, base } = writer
      const run = await window.studio.startScriptRun(brief, count, { id, model, base })
      draftRun.current = run.id
      viewRun(run)
      setToolsOpen(false)
    }
    catch (e) { setWriterError(String(e)) }
    finally { submitLock.current = false; setSubmitting(false) }
  }
  function composeNext(restore: boolean) {
    if (!viewedRun) return
    if (restore && (!brief.trim() || brief.trim() === viewedRun.brief)) {
      setBrief(viewedRun.brief); setCount(viewedRun.count)
    } else if (!restore && draftRun.current === viewedRun.id && brief.trim() === viewedRun.brief) {
      setBrief('')
    }
    draftRun.current = ''
    viewRun(null); select(''); setToolsOpen(true); setError(''); setWriterError('')
    requestAnimationFrame(() => document.getElementById('script-brief')?.focus())
  }
  return <section ref={desk} className="script-desk page-body" hidden={!active} aria-label="剧本工作台">
    {canCollapse && <button className="writing-tools-toggle" ref={toolsButton} aria-controls="writing-sidebar"
      aria-expanded={toolsOpen} onClick={() => setToolsOpen(open => !open)}>新建与切换剧本</button>}
    <aside id="writing-sidebar" className="writing-sidebar panel" aria-label="剧本工具" data-collapsed={canCollapse && !toolsOpen}>
      <form className="writing-form" onFocus={() => setToolsOpen(true)} onSubmit={e => { e.preventDefault(); void generate() }}>
        <h2>新建剧本</h2>
        <button type="button" onClick={() => edit('new')}>手写或粘贴分镜</button>
        <ExpandableText id="script-brief" label="故事构想" rows={5} maxLength={12000} required={!!writer?.hasKey}
          value={brief} change={setBrief} placeholder="主角是谁？故事在哪里发生？你想让观众记住什么？" />
        <label>分镜数量<select value={count} onChange={e => setCount(+e.target.value)}>
          {[1, 2, 3, 4, 6, 8, 12].map(n => <option key={n} value={n}>{n} 个分镜</option>)}</select></label>
        {canChooseWriter && <WriterSelector data={integrations} selectWriter={selectWriter} disabled={busy || switchingWriter} />}
        <button className="primary" disabled={busy || switchingWriter || !writer} onClick={e => { if (e.detail > 1) e.preventDefault() }}>
          {submitting ? '正在提交…' : busy ? '正在编写分镜…' : writer?.hasKey ? '生成剧本' : '配置剧本模型'}</button>
        {writer && !writer.hasKey && <small>自动生成分镜需要文本模型，也可以在上方手写或粘贴。</small>}
        {writer?.hasKey && !canChooseWriter && <small>{writerName(writer)} · {writer.model}</small>}
        {writerError && <ServiceError message={writerError} context="writer" configure={configure} />}
      </form>
      <section className="saved-scripts" aria-labelledby="saved-scripts-title">
        <header>
          <h2 id="saved-scripts-title">我的剧本</h2>
          <ProjectTransfer scriptId={script?.id} flush={beforeEdit} imported={async id => {
            await imported()
            setScripts(await window.studio.scripts())
            openScript(id)
          }} />
        </header>
        {scripts.length ? <ul className="script-history">
          {scripts.map(s => <li key={s.id}>
            <button title={s.title} aria-current={s.id === script?.id ? 'true' : undefined} onClick={() => openScript(s.id)}>
              <b>{s.title}</b><small>{s.scenes.length} 镜 · {new Date(s.created).toLocaleDateString()}</small>
            </button>
          </li>)}
        </ul> : <p>新建或导入的剧本会显示在这里。</p>}
      </section>
    </aside>
    <div key={viewedRun?.id ?? selected} className="manuscript">
      {error && <p className="form-error" role="alert">{error}</p>}
      {viewedRun && !savedRunId && <ScriptRunView run={viewedRun} active={active}
        background={() => composeNext(false)} edit={() => composeNext(true)} configure={configure}
        hasDraft={!!brief.trim() && brief.trim() !== viewedRun.brief} />}
      {!viewedRun && writingRuns.length > 0 && <div className="script-background-note">
        <span role="status">{writingRuns.length} 份剧本正在后台生成</span>
        <button className="link" onClick={() => { viewRun(writingRuns[0]); setToolsOpen(false) }}>查看进度</button>
      </div>}
      {script ? <>
        <header className="manuscript-title">
          <div className="manuscript-heading"><small>{script.scenes.length} 个分镜 · {script.model}</small>
            <h2>{script.title}</h2></div>
          <div className="project-actions" role="group" aria-label="剧本操作">
            <button onClick={() => edit(script)}>编辑剧本</button>
            <button onClick={() => setBatch(true)}>镜头队列与预算</button>
            <button onClick={() => setFilm(true)}>整片预览与交付</button>
          </div>
        </header>
        {film && <FilmPreview script={script} jobs={jobs} close={()=>setFilm(false)} frame={useFrame} locate={id=>{setFilm(false);requestAnimationFrame(()=>document.getElementById('scene-'+id)?.focus())}}/>}
        {batch && <ShotBatch key={script.id} script={script} close={()=>setBatch(false)} flush={beforeEdit}/>}
        {script.brief && <p className="story-brief">{script.brief}</p>}
        <ol className="shot-list">
          {script.scenes.map((scene, index) => {
            const link = {scriptId: script.id, sceneId: scene.id, label: `${script.title} · 第 ${index + 1} 镜`}
            const takes = takesByScene.get(scene.id) ?? []
            const finals = script.finals[scene.id] ?? {}
            const first = takes.find(j => j.id === finals.image && j.file)
            return <li key={scene.id} id={'scene-'+scene.id} tabIndex={-1}>
              <span className="shot-number" aria-label={`分镜 ${index + 1}`}>{String(index + 1).padStart(2, '0')}</span>
              <article>
                <div className="shot-copy">
                  <h3>{scene.heading}</h3><p>{scene.action}</p>
                  {scene.dialogue && <blockquote>{scene.dialogue}</blockquote>}
                </div>
                <div className="shot-tools">
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
                </div>
              </article>
            </li>
          })}
        </ol>
      </> : !viewedRun && <div className="script-empty"><h2>{runs.length || scripts.length ? '写下下一段故事构想' : '写下你的第一个分镜'}</h2><p>从故事构想开始，生成场景、动作、台词，以及每个镜头的图片和视频提示词。</p></div>}
      {savedRunId && !script && !error && <p role="status">正在打开已保存的剧本…</p>}
    </div>
    {editing && <ScriptEditor initial={editing === 'new' ? undefined : editing} beforeSave={beforeEdit}
      close={() => edit(null)} saved={s => { remember(s); edited(s); edit(null) }} />}
  </section>
}
