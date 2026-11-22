import { useMemo, useState } from 'react'
import { jobStatusGroup, siteTemplate, statusLabels, type JobStatusGroup, type JobView, type ScriptRun } from '../shared'
import { Modal } from './Editor'
import { paginate, PageControls } from './LibraryPages'
import { canResume, taskGuidance, useVisibleTime } from './taskHelp'

type Filter = JobStatusGroup | 'all'
const filters: Record<Filter, string> = { all: '全部', active: '进行中', attention: '待处理', done: '已完成' }
const timeFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function jobAction(job: JobView) {
  if (jobStatusGroup(job.status) === 'active') return '查看进度'
  return job.file ? '查看结果' : '查看详情'
}

function TaskRow({ job, inspect, now }: { job: JobView; inspect: (job: JobView) => void; now: number }) {
  const [resuming, setResuming] = useState(false)
  const [error, setError] = useState('')
  const media = job.kind === 'image' ? '图片' : '视频'
  const model = siteTemplate(job.model)?.Name || job.model
  const hint = taskGuidance(job, now)?.title ?? job.detail
  async function resume() {
    setError('')
    setResuming(true)
    try { await window.studio.resume(job.id) }
    catch (e) { setError(String(e)) }
    finally { setResuming(false) }
  }
  return (
    <li className="task-row" data-group={jobStatusGroup(job.status)}>
      <div className="task-copy">
        <strong title={job.prompt}>{job.prompt || model || media + '任务'}</strong>
        <small>{[media, model, job.shot?.label, job.created > 0 && timeFormat.format(job.created)].filter(Boolean).join(' · ')}</small>
        {hint && <span className="task-detail" title={hint}>{hint}</span>}
        {error && <span role="alert" className="error">{error}</span>}
      </div>
      <span className="task-state">{statusLabels[job.status] || job.status}</span>
      <div className="task-actions">
        {canResume(job) && <button disabled={resuming} title="从已有任务号或结果地址继续" onClick={() => void resume()}>恢复任务</button>}
        <button onClick={() => inspect(job)}>{jobAction(job)}</button>
      </div>
    </li>
  )
}

type Task = JobView | ScriptRun
function statusGroup(task: Task): JobStatusGroup {
  if ('kind' in task) return jobStatusGroup(task.status)
  return task.status === 'writing' ? 'active' : task.status === 'done' ? 'done' : 'attention'
}
const scriptStates: Record<ScriptRun['status'], string> = { writing: '正在编写', done: '已保存', failed: '生成失败', interrupted: '已中断' }

function ScriptTaskRow({ run, inspect }: { run: ScriptRun; inspect: () => void }) {
  return <li className="task-row" data-group={statusGroup(run)}>
    <div className="task-copy">
      <strong title={run.brief}>{run.title || run.brief}</strong>
      <small>{['剧本', run.count + ' 个分镜', run.service, run.model, timeFormat.format(run.created)].filter(Boolean).join(' · ')}</small>
      {(run.error || run.title) && <span className="task-detail" title={run.error || run.brief}>{run.error || run.brief}</span>}
    </div>
    <span className="task-state">{scriptStates[run.status]}</span>
    <div className="task-actions"><button onClick={inspect}>
      {run.status === 'writing' ? '查看进度' : run.status === 'done' ? '查看剧本' : '查看详情'}
    </button></div>
  </li>
}

export function BackgroundTasks({ jobs, scriptRuns, inspect, inspectScript }: {
  jobs: JobView[]; scriptRuns: ScriptRun[]; inspect: (job: JobView) => void; inspectScript: (run: ScriptRun) => void
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(1)
  const groups = useMemo(() => {
    const lists: Record<Filter, Task[]> = { all: [...jobs, ...scriptRuns].sort((a, b) => b.created - a.created), active: [], attention: [], done: [] }
    for (const task of lists.all) lists[statusGroup(task)].push(task)
    return lists
  }, [jobs, scriptRuns])
  const active = groups.active.length
  const now = useVisibleTime(open && active > 0, 15000)
  function select(next: Filter) {
    setFilter(next)
    setPage(1)
  }
  const visible = paginate(groups[filter], page, 20)
  return <>
    <button className="tasks-launcher" aria-label="后台任务" aria-haspopup="dialog"
      aria-describedby="task-count" onClick={() => { select(active ? 'active' : groups.attention.length ? 'attention' : 'all'); setOpen(true) }}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
        <path d="M9 6h11M9 12h11M9 18h7M4 6h.1M4 12h.1M4 18h.1" />
      </svg>
      后台任务
      <span id="task-count" aria-label={active + ' 项进行中'} data-active={active > 0}>{active}</span>
      {groups.attention.length > 0 && <span className="task-attention">{groups.attention.length} 待处理</span>}
    </button>
    {open && <Modal title="后台任务" wide close={() => setOpen(false)}>
      <div className="task-filters" role="group" aria-label="筛选后台任务">
        {(Object.keys(filters) as Filter[]).map(key => (
          <button key={key} aria-pressed={key === filter} onClick={() => select(key)}>
            {filters[key]} <span>{groups[key].length}</span>
          </button>
        ))}
      </div>
      {visible.items.length ? (
        <ul className="task-rows" key={filter + visible.page} aria-label={filters[filter] + '任务'}>
          {visible.items.map(task => 'kind' in task
            ? <TaskRow key={task.id} job={task} now={now} inspect={j => { setOpen(false); inspect(j) }} />
            : <ScriptTaskRow key={task.id} run={task} inspect={() => { setOpen(false); inspectScript(task) }} />)}
        </ul>
      ) : (
        <div className="task-empty">
          <p>{filter === 'all' ? '还没有生成任务' : '暂无' + filters[filter] + '的任务'}</p>
          {filter === 'active' && groups.done.length > 0 && <button onClick={() => select('done')}>查看已完成任务</button>}
        </div>
      )}
      <PageControls page={visible.page} pages={visible.pages} label="后台任务分页" change={setPage}/>
    </Modal>}
  </>
}
