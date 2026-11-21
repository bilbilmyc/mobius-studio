import { useLayoutEffect, useState } from 'react'
import { statusLabels, type JobView } from '../shared'

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

function WaitTime({ created, retryAt }: Pick<JobView, 'created' | 'retryAt'>) {
  const [now, setNow] = useState(Date.now)
  useLayoutEffect(() => {
    let timer: number | undefined
    function sync() {
      window.clearInterval(timer)
      if (document.hidden) return
      setNow(Date.now())
      timer = window.setInterval(() => setNow(Date.now()), 1000)
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [created, retryAt])
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

export function JobPreviewState({ job, retry }: { job: JobView; retry?: () => void }) {
  const media = job.kind === 'image' ? '图片' : '视频'
  const state = retry ? 'unreadable' : job.status
  const phase = ['preparing', 'submitting'].includes(state)
    ? 0
    : state === 'waiting'
      ? 1
      : state === 'downloading'
        ? 2
        : -1
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
          <p>{detail}</p>
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
          <WaitTime created={job.created} retryAt={job.retryAt} />
        )}
        {retry && <button onClick={retry}>重新加载预览</button>}
      </div>
    </div>
  )
}
