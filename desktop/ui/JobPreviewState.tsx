import { useState } from 'react'
import { statusLabels, type JobView } from '../shared'
import { invoke } from '@tauri-apps/api/core'
import { ReceiptRecovery } from './ReceiptRecovery'
import { canResume, interruptedDownload, taskGuidance, useVisibleTime } from './taskHelp'

const stages = ['提交任务', '模型生成', '保存原文件']

function duration(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  const pair = (n: number) => String(n).padStart(2, '0')
  return (
    (minutes >= 60 ? Math.floor(minutes / 60) + ':' : '') +
    pair(minutes % 60) +
    ':' +
    pair(seconds % 60)
  )
}

function WaitTime({ created, retryAt, now }: Pick<JobView, 'created' | 'retryAt'> & { now: number }) {
  const elapsed = created > 0 ? duration(Math.max(0, Math.floor((now - created) / 1000))) : ''
  const retry = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0
  return (
    <div className="wait-time" role="timer" aria-live="off">
      {elapsed && (
        <span>
          已用时 <b>{elapsed}</b>
        </span>
      )}
      {retryAt && (
        <span>
          {retry ? (
            <>
              <b>{duration(retry)}</b> 后重试
            </>
          ) : (
            '正在重新查询'
          )}
        </span>
      )}
    </div>
  )
}

export function JobPreviewState({ job, retry, configure, reuse, promptOnly }: {
  job: JobView; retry?: () => void; configure: () => void; reuse: () => Promise<void>; promptOnly: boolean
}) {
  const [busy, setBusy] = useState(false), [feedback, setFeedback] = useState('')
  const media = job.kind === 'image' ? '图片' : '视频'
  const state = retry ? 'unreadable' : job.status
  const phase = ['preparing', 'submitting'].includes(state)
    ? 0
    : state === 'waiting'
      ? 1
      : state === 'downloading'
        ? 2
        : -1
  const now = useVisibleTime(phase >= 0, 1000)
  const guide = !retry && taskGuidance(job, now)
  async function perform(action: () => Promise<void | string>, success = '', fallback = '') {
    if (busy) return
    setFeedback(''); setBusy(true)
    try { const message=await action(); setFeedback(typeof message==='string'?message:success) }
    catch (e) { setFeedback(fallback || String(e)) }
    finally { setBusy(false) }
  }
  const titles: Record<string, string> = {
    preparing: '正在准备素材',
    submitting: '正在提交' + media + '任务',
    waiting: '正在生成' + media,
    downloading: '正在保存' + media,
    done: '找不到本地原文件',
    unreadable: media + '预览未能打开',
    paused: '任务待恢复',
    uncertain: '提交结果待核实',
    failed: media + '生成失败',
  }
  const detail =
    state === 'unreadable'
      ? '可以重新加载预览，也可以打开原文件查看。'
      : state === 'done'
        ? '请检查原文件是否已移动。'
        : job.detail || (phase >= 0 ? '完成后会在这里显示作品。' : '可在下方查看任务记录。')
  return (
    <div className="job-preview" data-active={phase >= 0} data-state={state}>
      {phase >= 0 && <div className="preview-flow" aria-hidden="true" />}
      <div className="preview-state-content">
        <div className="preview-symbol" aria-hidden="true">
          <svg
            viewBox="0 0 28 28"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {phase >= 0 ? (
              job.kind === 'image' ? (
                <>
                  <rect x="3.5" y="5" width="21" height="18" rx="3" />
                  <circle cx="10" cy="11" r="1.6" />
                  <path d="m5 21 6-6 3 3 4.5-5 5 6" />
                </>
              ) : (
                <>
                  <rect x="3" y="6" width="16" height="16" rx="3" />
                  <path d="m19 12 6-4v12l-6-4" />
                </>
              )
            ) : state === 'paused' ? (
              <path d="M10 7v14m8-14v14" />
            ) : (
              <>
                <circle cx="14" cy="14" r="10" />
                <path d="M14 8v7m0 4h.01" />
              </>
            )}
          </svg>
        </div>
        <div role="status" aria-live="polite" aria-atomic="true">
          <h2>{titles[state] ?? statusLabels[state] ?? '等待任务状态'}</h2>
          <p>{guide ? guide.title : detail}</p>
        </div>
        {phase >= 0 && (
          <ol className="preview-stages" aria-label="任务阶段">
            {stages.map((label, i) => (
              <li
                key={label}
                data-finished={i < phase}
                aria-current={i === phase ? 'step' : undefined}
              >
                <i aria-hidden="true" />
                {label}
              </li>
            ))}
          </ol>
        )}
        {phase >= 0 && (job.created > 0 || !!job.retryAt) && (
          <WaitTime created={job.created} retryAt={job.retryAt} now={now} />
        )}
        {job.protocol==='comfy-image'&&job.remoteId&&['waiting','paused'].includes(state)&&<button disabled={busy} onClick={()=>void perform(()=>invoke<string>('cancel_remote',{id:job.id}))}>取消此远端任务</button>}
        {job.status==='uncertain'&&<details><summary>记录人工核对结果</summary>{['服务商确认未受理','已在官网人工取回'].map(outcome=><button key={outcome} disabled={busy} onClick={()=>void perform(()=>invoke('mark_reconciled',{id:job.id,outcome}))}>{outcome}</button>)}</details>}
        {guide && <div className="task-guidance" role="group" aria-label="处理建议">
          <p className="guide-target">{[media, job.profileName, job.model].filter(Boolean).join(' · ')}</p>
          <p>{guide.advice}</p>
          {job.remoteId && <p className="task-ticket">服务商任务号 <code>{job.remoteId}</code></p>}
          {phase >= 0 && !!job.progressAt && <p>上次状态变化 {new Date(job.progressAt).toLocaleString()}</p>}
          <div className="guidance-actions">
            {guide.connection && <button onClick={configure}>检查生成服务</button>}
            {canResume(job) && <button className="primary" disabled={busy} onClick={() => void perform(() => window.studio.resume(job.id))}>
              {interruptedDownload(job) ? '重新下载结果' : '继续查询原任务'}</button>}
            {job.status === 'failed' && <button disabled={busy} onClick={() => void perform(reuse)}>{promptOnly ? '仅复用提示词' : '复用参数'}</button>}
            <button disabled={busy} onClick={() => void perform(() => window.studio.copyTaskInfo(job.id), '排查信息已复制。', '未能复制，请展开技术详情，手动选取任务号和提交时间。')}>复制排查信息</button>
          </div>
          {job.status === 'uncertain' && job.protocol.startsWith('rh-') && <ReceiptRecovery key={job.id} job={job} />}
          {feedback && <p role="status">{feedback}</p>}
          <details><summary>技术详情</summary>
            <p>{job.detail || '服务商未返回具体原因。'}</p>
            {job.created > 0 && <p>提交时间 {new Date(job.created).toLocaleString()}</p>}
            <p>本地记录号 <code>{job.id}</code></p>
          </details>
        </div>}
        {retry && <button onClick={retry}>重新加载预览</button>}
      </div>
    </div>
  )
}
