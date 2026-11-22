import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

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
        e.stopPropagation()
        close()
      }}
    >
      <div className="dialog-title">
        <h2>{title}</h2>
        <button type="button" className="icon-btn" aria-label="关闭" onClick={close}>
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
  let length = 0
  for (const _ of segmenter?.segment(s) ?? s) length++
  return length
}
function selectionOf(input: HTMLTextAreaElement) {
  return [input.selectionStart, input.selectionEnd, input.selectionDirection] as const
}

export function ExpandableText({
  id,
  label,
  value,
  change,
  placeholder,
  rows = 4,
  required,
  maxLength,
  autoGrow = false,
  tools,
}: {
  id?: string
  label: string
  value: string
  change: (s: string) => void
  placeholder?: string
  rows?: number
  required?: boolean
  maxLength?: number
  autoGrow?: boolean
  tools?: React.ReactNode
}) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const box = useRef<HTMLTextAreaElement>(null),
    big = useRef<HTMLTextAreaElement>(null)
  const [original, setOriginal] = useState<string | null>(null)
  const selection = useRef<ReturnType<typeof selectionOf>>([0, 0, 'none'])
  const expanded = original !== null
  const counter = useMemo(() => {
    if (!autoGrow && !expanded) return ''
    if (maxLength !== undefined) return value.length.toLocaleString('zh-CN') + ' / ' + maxLength.toLocaleString('zh-CN')
    return count(value) + ' 字'
  }, [autoGrow, expanded, maxLength, value])
  useLayoutEffect(() => {
    const el = box.current
    if (autoGrow && el) {
      el.style.height = 'auto'
      el.style.height = Math.min(206, Math.max(98, el.scrollHeight + 2)) + 'px'
    }
  }, [autoGrow, value, placeholder])
  useEffect(() => {
    if (expanded) big.current?.setSelectionRange(...selection.current)
  }, [expanded])
  function finish(save: boolean) {
    const pos =
      save && big.current
        ? selectionOf(big.current)
        : selection.current
    if (!save && original !== null && value !== original) change(original)
    setOriginal(null)
    requestAnimationFrame(() => {
      box.current?.focus({ preventScroll: true })
      box.current?.setSelectionRange(...pos)
    })
  }
  return (
    <div className={autoGrow ? 'prompt' : 'writing-field'}>
      <div className="label-row">
        <label id={inputId + '-label'} htmlFor={inputId}>{label}</label>
        {autoGrow && <small>{counter}</small>}
        {tools}
        <button
          type="button"
          className="link"
          aria-haspopup="dialog"
          aria-describedby={inputId + '-label'}
          onClick={() => {
            selection.current = selectionOf(box.current!)
            setOriginal(value)
          }}
        >
          展开编辑 ↗
        </button>
      </div>
      <textarea
        id={inputId}
        ref={box}
        rows={rows}
        required={required}
        maxLength={maxLength}
        placeholder={placeholder}
        value={value}
        onChange={(e) => change(e.target.value)}
        spellCheck={false}
      />
      {expanded && createPortal(
        <Modal title={'编辑' + label} close={() => finish(false)} initialFocus={big} wide>
          <textarea
            ref={big}
            className="big-editor"
            aria-label={'完整' + label}
            maxLength={maxLength}
            placeholder={placeholder}
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
            <small>{counter}　·　Ctrl / ⌘ + Enter 完成</small>
            <button type="button" onClick={() => finish(false)}>取消</button>
            <button type="button" className="primary" onClick={() => finish(true)}>
              完成
            </button>
          </footer>
        </Modal>,
        document.body,
      )}
    </div>
  )
}
