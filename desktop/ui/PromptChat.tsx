import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Integrations } from '../shared'
import { runPromptTurn, sourceLabels, type WritingContext } from '../agent/promptAgent'
import type { PromptSession, PromptTurn } from '../agent/types'
import { Modal } from './Editor'
import { PromptTemplates } from './PromptTemplates'

interface Props {
  context: WritingContext
  writer?: Integrations['writer']
  useDraft: (turn: PromptTurn) => void
}

export function PromptChat(props: Props) {
  const [open, setOpen] = useState(false)
  return <>
    <button className="link" onClick={() => setOpen(true)}>对话改稿</button>
    {open && createPortal(<ChatDialog {...props} close={() => setOpen(false)} />, document.body)}
  </>
}

function ChatDialog({ context, writer, useDraft, close }: Props & { close: () => void }) {
  const [scope] = useState(context.scope)
  const [session, setSession] = useState<PromptSession | null>(null)
  const [memory, setMemory] = useState('')
  const [input, setInput] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [reload, refresh] = useState(0)
  const pending = useRef<AbortController | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const latest = useRef<HTMLElement>(null)

  useEffect(() => {
    let alive = true
    setSession(null)
    setError('')
    window.studio.promptSession(scope).then(saved => {
      if (alive) { setSession(saved); setMemory(saved.memory) }
    }).catch(e => { if (alive) setError(String(e)) })
    return () => { alive = false; pending.current?.abort() }
  }, [scope, reload])
  useEffect(() => { latest.current?.scrollIntoView({ block: 'nearest' }) }, [session?.revision])

  async function perform(label: string, operation: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setStatus(label)
    setError('')
    try { await operation(controller.signal) }
    catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)) }
    finally {
      if (!controller.signal.aborted) { setStatus(''); pending.current = null }
    }
  }

  function send() {
    if (!session || !writer?.hasKey || !input.trim() || memory !== session.memory) return
    void perform('正在改稿…', async signal => {
      const saved = await runPromptTurn(window.studio, { id: writer.id, model: writer.model, base: writer.base }, session, context, input, signal, setStatus)
      if (!signal.aborted) { setSession(saved); setMemory(saved.memory); setInput(''); field.current?.focus() }
    })
  }

  function persistMemory() {
    if (!session) return
    void perform('正在保存记忆…', async signal => {
      const saved = await window.studio.savePromptMemory(scope, session.memory, memory)
      if (!signal.aborted) { setMemory(saved); setSession({ ...session, memory: saved }) }
    })
  }

  function clearChat() {
    if (!session) return
    void perform('正在清空本段对话…', async signal => {
      const saved = await window.studio.updatePromptSession(scope, session.revision, null)
      if (!signal.aborted) { setSession(saved); setMemory(saved.memory); setConfirmClear(false); setShowAll(false) }
    })
  }

  const turns = session?.turns ?? []
  const visible = showAll ? turns : turns.slice(-3)
  const memoryDirty = !!session && memory !== session.memory
  return <Modal title="对话改稿" wide close={close} initialFocus={field}>
    <div className="dialog-body prompt-chat">
      <div className="optimizer-context"><span>{scope.shot?.label ?? '自由创作'} · {scope.kind === 'image' ? '图片' : '视频'}</span><small>{writer?.model}</small>
        <PromptTemplates kind={scope.kind} disabled={!!status} seed={context.candidate || context.original || input}
          maxLength={Math.max(0,4000-input.length-(input ? 1 : 0))} applyLabel={input ? "追加到改稿要求" : "填入改稿要求"}
          apply={text=>setInput(old=>old ? old+"\n"+text : text)} /></div>
      <details className="chat-memory"><summary>{scope.shot ? '本剧本的创作记忆' : '自由创作记忆'}{session?.memory ? ' · 已保存' : ''}</summary>
        <label>长期创作要求<textarea aria-label="长期创作要求" value={memory} maxLength={2000} disabled={!session || !!status}
          onChange={e => setMemory(e.target.value)} placeholder="例如：本片人物始终穿深蓝工作服，沿用冷色自然光。" /></label>
        <div><small>{scope.shot ? '同一剧本的分镜共用。' : '自由创作的图片和视频共用。'}清空后保存即可忘记。</small>
          <button disabled={!memoryDirty || !!status} onClick={persistMemory}>保存记忆</button></div>
      </details>
      {!!turns.length && <section className="chat-history" aria-label="改稿记录">
        {turns.length > 3 && <button className="link" onClick={() => setShowAll(!showAll)}>{showAll ? '只看最近三轮' : '查看更早对话'}</button>}
        {visible.map((turn, i) => <article key={turns.length - visible.length + i} ref={i === visible.length - 1 ? latest : undefined}>
          <b>你的要求</b><p>{turn.user}</p>
          <b>{turn.model}</b><p>{turn.reply}</p>
          {!!turn.sources.length && <small>本轮已查阅 {turn.sources.map(source => sourceLabels[source]).join('、')}</small>}
          {turn.prompt && <><blockquote>{turn.prompt}</blockquote><button className="link" disabled={!!status}
            onClick={() => { useDraft(turn); close() }}>放入优化稿</button></>}
        </article>)}
      </section>}
      <label>这次想怎么改<textarea ref={field} aria-label="改稿要求" maxLength={4000} value={input}
        readOnly={!!status} onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }}
        placeholder="例如：沿用上一版构图，让光从右侧照进来。" /></label>
      {status && <span role="status">{status}</span>}
      {!writer?.hasKey && <small>连接「设置 → 剧本模型」后即可发送。</small>}
      {memoryDirty && <small>发送前请保存记忆，或恢复已保存的内容。 <button className="link" disabled={!!status} onClick={() => setMemory(session!.memory)}>恢复已保存内容</button></small>}
      {error && <p className="form-error" role="alert">{error} <button className="link" onClick={() => refresh(n => n + 1)}>重新读取对话</button></p>}
    </div>
    <footer className="modal-actions optimizer-actions">
      {!!turns.length && (confirmClear ? <><span>清空这段对话？</span><button disabled={!!status} onClick={clearChat}>确认清空</button>
        <button onClick={() => setConfirmClear(false)}>取消</button></> :
        <button className="link" disabled={!!status || memoryDirty} onClick={() => setConfirmClear(true)}>清空对话</button>)}
      <button onClick={close}>{status ? '停止并返回' : '返回对照'}</button>
      <button className="primary" disabled={!session || !!status || memoryDirty || !writer?.hasKey || !input.trim()} onClick={send}>发送改稿要求</button>
    </footer>
  </Modal>
}
