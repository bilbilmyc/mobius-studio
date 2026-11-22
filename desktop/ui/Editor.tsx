import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'

export function Modal({
  title,
  close,
  children,
  wide = false,
  initialFocus,
}: {
  title: string
  close: () => void
  children: React.ReactNode
  wide?: boolean
  initialFocus?: React.RefObject<HTMLElement | null>
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = ref.current!
    el.showModal()
    initialFocus?.current?.focus()
    return () => el.close()
  }, [initialFocus])
  return (
    <dialog
      ref={ref}
      className={wide ? 'wide' : ''}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
    >
      <div className="dialog-title">
        <h2>{title}</h2>
        <button className="icon-btn" aria-label="关闭" onClick={close}>
          ×
        </button>
      </div>
      {children}
    </dialog>
  )
}
const segmenter =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
    : null
function count(s: string) {
  return segmenter ? [...segmenter.segment(s)].length : Array.from(s).length
}
export function Prompt({
  value,
  change,
  hint,
  tools,
}: {
  value: string
  change: (s: string) => void
  hint: string
  tools?: React.ReactNode
}) {
  const box = useRef<HTMLTextAreaElement>(null),
    big = useRef<HTMLTextAreaElement>(null)
  const [original, setOriginal] = useState<string | null>(null),
    selection = useRef([0, 0])
  useLayoutEffect(() => {
    const el = box.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(206, Math.max(98, el.scrollHeight + 2)) + 'px'
    }
  }, [value, hint])
  const expanded = original !== null
  useEffect(() => {
    if (expanded && big.current) {
      big.current.focus()
      big.current.setSelectionRange(selection.current[0], selection.current[1])
    }
  }, [expanded])
  function finish(save: boolean) {
    const pos =
      save && big.current
        ? [big.current.selectionStart, big.current.selectionEnd]
        : selection.current
    if (!save && original !== null && value !== original) change(original)
    setOriginal(null)
    requestAnimationFrame(() => {
      box.current?.focus()
      box.current?.setSelectionRange(pos[0], pos[1])
    })
  }
  return (
    <section className="prompt">
      <div className="label-row">
        <label htmlFor="prompt">提示词</label>
        <small>{count(value)} 字</small>
        {tools}
        <button
          className="link"
          onClick={() => {
            selection.current = [
              box.current!.selectionStart,
              box.current!.selectionEnd,
            ]
            setOriginal(value)
          }}
        >
          展开编辑 ↗
        </button>
      </div>
      <textarea
        id="prompt"
        ref={box}
        rows={4}
        placeholder={hint}
        value={value}
        onChange={(e) => change(e.target.value)}
        spellCheck={false}
      />
      {expanded && (
        <Modal title="编辑提示词" close={() => finish(false)} wide>
          <textarea
            ref={big}
            className="big-editor"
            aria-label="完整提示词"
            spellCheck={false}
            value={value}
            onChange={(e) => change(e.target.value)}
            onKeyDown={(e) => {
              if (
                (e.ctrlKey || e.metaKey) &&
                e.key === 'Enter' &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault()
                e.stopPropagation()
                finish(true)
              }
            }}
          />
          <footer className="modal-actions">
            <small>{count(value)} 字　·　Ctrl / ⌘ + Enter 完成</small>
            <button onClick={() => finish(false)}>取消</button>
            <button className="primary" onClick={() => finish(true)}>
              完成
            </button>
          </footer>
        </Modal>
      )}
    </section>
  )
}
