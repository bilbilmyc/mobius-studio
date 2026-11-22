import { useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  type Composer, type Integrations, type MediaKind, type OptimizationMode, type Picked,
  type PromptOptimization, type PromptReferences, type PromptSuggestion, type ShotLink,
} from '../shared'
import { frameOrder } from './Assets'
import { Modal } from './Editor'
import { PromptChat } from './PromptChat'
import { ServiceError } from './UsageHelp'

export const optimizationModes = { polish: '润色原意', enrich: '丰富细节' } as const
type Activity = { input: PromptOptimization; busy: boolean; error?: string }

function sameRequest(a: PromptOptimization, b: PromptOptimization) {
  return a.kind === b.kind && a.prompt === b.prompt && a.mode === b.mode && a.references === b.references
}

export function generationCandidate(composer: Composer, input: PromptOptimization): PromptSuggestion | undefined {
  const { suggestion, appliedOptimization } = composer
  if (suggestion && suggestion.original === input.prompt && suggestion.mode === input.mode && suggestion.references === input.references)
    return suggestion
  if (appliedOptimization && appliedOptimization.text === input.prompt && appliedOptimization.mode === input.mode && appliedOptimization.references === input.references)
    return { ...appliedOptimization, original: input.prompt }
}

export function adoptPrompt(old: Composer, suggestion: PromptSuggestion): Composer {
  const { text, model, mode, references, source } = suggestion
  return {
    ...old, prompt: text, suggestion: undefined, appliedOptimization: { text, model, mode, references, source },
    promptBeforeOptimization: old.appliedOptimization?.text === text && old.prompt === text
      ? old.promptBeforeOptimization : old.prompt,
  }
}

export function promptReferences(kind: MediaKind, intent: string, assets: Picked[]): PromptReferences {
  if (!assets.length) return 'none'
  if (kind !== 'video' || !['first_last', 'first_frame'].includes(intent)) return 'reference'
  const frames = frameOrder(assets)
  if (frames.length > 1) return 'first_last'
  return frames[0].role === 'last_frame' ? 'last_frame' : 'first_frame'
}

// Keep requests at the app level so navigation can unmount the editor without losing the reply.
export function usePromptRequests() {
  const entries = useRef(new Map<string, Activity>())
  const [, refresh] = useReducer(n => n + 1, 0)
  function clear(scope: string) {
    if (entries.current.delete(scope)) refresh()
  }
  function supersedeIfChanged(scope: string, input: PromptOptimization) {
    const previous = entries.current.get(scope)
    if (previous && !sameRequest(previous.input, input)) clear(scope)
  }
  async function start(scope: string, input: PromptOptimization, receive: (s: PromptSuggestion) => void) {
    if (entries.current.get(scope)?.busy || !input.prompt.trim()) return
    const request = { input, busy: true }
    entries.current.set(scope, request)
    refresh()
    try {
      const result = await window.studio.optimizePrompt(input)
      if (entries.current.get(scope) !== request) return
      receive({ ...result, original: input.prompt, mode: input.mode, references: input.references })
      entries.current.delete(scope)
    } catch (e) {
      if (entries.current.get(scope) === request) entries.current.set(scope, { ...request, busy: false, error: String(e) })
    } finally { refresh() }
  }
  return { entries: entries.current, start, clear, supersedeIfChanged }
}

interface Props {
  composer: Composer
  writer?: Integrations['writer']
  activity?: Activity
  start: (mode: OptimizationMode) => void
  change: (edit: (old: Composer) => Composer) => void
  configure: () => void
  shot?: ShotLink
  assets: Picked[]
  kind: MediaKind
  references: PromptReferences
  generation?: {
    input: PromptOptimization
    models: string
    action: string
    submitting: boolean
    error: string
    submit: (choice: 'original' | 'suggestion') => void
    close: () => void
  }
}

export function PromptOptimizer({ composer, writer, activity, start, change, configure, shot, assets, kind, references, generation }: Props) {
  const [open, show] = useState(false)
  const [mode, select] = useState<OptimizationMode>('polish')
  const originalField = useRef<HTMLTextAreaElement>(null)
  const busy = !!activity?.busy
  const suggestion = generation ? generationCandidate(composer, generation.input) : composer.suggestion
  const changed = !!suggestion && suggestion.original !== composer.prompt
  const submitting = !!generation?.submitting

  function editOriginal(prompt: string) {
    change(old => ({ ...old, prompt,
      suggestion: old.suggestion?.edited ? { ...old.suggestion, original: prompt } : old.suggestion,
    }))
  }
  function editSuggestion(text: string) {
    change(old => ({ ...old, suggestion: {
      ...(suggestion ?? { original: old.prompt, mode: generation?.input.mode ?? mode, references, model: '' }),
      text, edited: true,
    } }))
  }

  function close() {
    if (submitting) return
    show(false)
    generation?.close()
  }

  function adopt() {
    if (!suggestion?.text.trim()) return
    if (generation) { generation.submit('suggestion'); return }
    change(old => adoptPrompt(old, suggestion))
    show(false)
  }
  function restore() {
    change(old => old.promptBeforeOptimization === undefined ? old : {
      ...old, prompt: old.promptBeforeOptimization, promptBeforeOptimization: undefined, appliedOptimization: undefined,
    })
  }
  return <>
    <button className="link" onClick={() => {
      select(activity?.input.mode ?? composer.suggestion?.mode ?? 'polish')
      show(true)
    }}>{busy ? '优化中…' : suggestion ? '查看优化稿' : '优化提示词'}</button>
    {composer.promptBeforeOptimization !== undefined &&
      <button className="link" title="恢复采用前的提示词" onClick={restore}>还原原文</button>}
    {(open || generation) && createPortal(<Modal title={generation ? '生成前优化' : '优化提示词'} wide close={close} initialFocus={originalField}>
      <div className="dialog-body optimizer-body">
        <div className="optimizer-context"><span>{[shot?.label, kind === 'image' ? '图片' : '视频'].filter(Boolean).join(' · ')}</span>
          {writer?.model && <small>{writer.model}</small>}
          {!generation && <PromptChat writer={writer} context={{ scope: { kind, shot }, original: composer.prompt,
            candidate: suggestion?.text ?? '', references, assets }} useDraft={turn => {
              const text = turn.prompt
              if (text) change(old => ({ ...old, suggestion: { original: turn.original, text,
                source: 'conversation', model: turn.model, mode, references } }))
            }} />}</div>
        {generation ? <div className="generation-review-models"><b>{optimizationModes[generation.input.mode]}</b><span>{generation.models}</span></div> :
        <div role="group" aria-label="优化方式" className="optimizer-modes">
          {(Object.keys(optimizationModes) as OptimizationMode[]).map(key =>
            <button key={key} disabled={busy} aria-pressed={mode === key} aria-label={optimizationModes[key]} onClick={() => select(key)}>
              <strong>{optimizationModes[key]}</strong><small>{key === 'polish' ? '保留已有设定，理顺表达' :
                kind === 'image' ? '补充构图、材质与光线' : '补充动作、运镜与节奏'}</small>
            </button>)}
        </div>}
        <div className="optimizer-columns">
          <label>原文<textarea aria-label="优化原文" ref={originalField} readOnly={submitting} value={composer.prompt}
            onChange={e => editOriginal(e.target.value)} placeholder="输入或粘贴提示词" /></label>
          <label><span>优化稿 {suggestion && <small>{suggestion.model ? `${suggestion.source === 'conversation' ? '对话改稿' : optimizationModes[suggestion.mode]} · ${suggestion.model}` : '手动编辑'}</small>}</span>
            <textarea aria-label="优化稿" value={suggestion?.text ?? ''} readOnly={submitting}
              placeholder={busy ? '正在优化，也可直接写入自己的版本' : '可直接写优化稿，或点击「开始优化」'}
              onChange={e => editSuggestion(e.target.value)} /></label>
        </div>
        {busy && <p role="status">正在优化。可以收起窗口继续创作。</p>}
        {activity?.error && <ServiceError message={activity.error} context="writer" configure={() => { close(); configure() }} />}
        {generation?.error && <p className="form-error" role="alert">{generation.error}</p>}
        {changed && <details className="optimizer-history"><summary>当前草稿已修改，查看优化时的原文</summary><p>{suggestion.original}</p></details>}
        {writer && !writer.hasKey && <p>提示词优化还没有连接文本模型。在「设置 → 剧本模型」填写服务地址、模型 ID 和 Key。{generation && '这次也可以直接用原文生成。'}</p>}
      </div>
      <footer className="modal-actions optimizer-actions">
        <button disabled={submitting} onClick={close}>{busy ? '收起' : '关闭对照'}</button>
        {generation && <button disabled={submitting} onClick={() => generation.submit('original')}>用原文生成</button>}
        {writer && !writer.hasKey ? <button disabled={submitting} onClick={() => { close(); configure() }}>配置剧本模型</button> :
          <button className={suggestion ? '' : 'primary'} disabled={submitting || busy || !writer || !composer.prompt.trim()}
            onClick={() => start(generation?.input.mode ?? mode)}>{suggestion?.model ? (changed ? '用当前草稿重新优化' : '重新优化') : '开始优化'}</button>}
        {suggestion && <button className="primary" disabled={submitting || !suggestion.text.trim()} onClick={adopt}>
          {submitting ? '正在添加任务…' : generation ? '采用并' + generation.action : changed ? '替换当前草稿' : '采用优化稿'}</button>}
      </footer>
    </Modal>, document.body)}
  </>
}
