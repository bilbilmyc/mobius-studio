import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { convertFileSrc } from '@tauri-apps/api/core'
import { siteTemplate, statusLabels, type JobView, type PerformanceMode } from '../shared'
import { LibraryThumbnail } from './LibraryThumbnail'

interface Props {
  performance: PerformanceMode
  job: JobView
  selected: boolean
  featured: boolean
  choose: () => void
  inspect: () => void
  makeVideo: () => void
  saveOriginal: () => void
  copyImage: (link: boolean) => void
}

export function WorkCard({ job, selected, featured, choose, inspect, makeVideo, saveOriginal, copyImage, performance }: Props) {
  const card = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [failedPreview, setFailedPreview] = useState<string>()
  const hasOriginal = job.status === 'done' && job.file && !!job.mediaPath
  const canUseImage = job.kind === 'image' && hasOriginal
  const original = featured && canUseImage && failedPreview !== job.mediaPath ? job.mediaPath : undefined
  const title = job.prompt || siteTemplate(job.model)?.Name || '视频处理'

  function openMenu(x: number, y: number) {
    choose()
    setMenu({ x, y })
  }
  useLayoutEffect(() => {
    if (!menu || !popup.current) return
    const el = popup.current
    el.style.left = Math.max(4, Math.min(menu.x, window.innerWidth - el.offsetWidth - 4)) + 'px'
    el.style.top = Math.max(4, Math.min(menu.y, window.innerHeight - el.offsetHeight - 4)) + 'px'
    el.querySelector('button')?.focus({ preventScroll: true })
  }, [menu])
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const outside = (e: Event) => { if (!popup.current?.contains(e.target as Node)) close() }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('focusin', outside)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('focusin', outside)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const actions: [string, () => void][] = [['查看作品', inspect]]
  if (hasOriginal) actions.push(['另存原文件', saveOriginal])
  if (canUseImage) {
    actions.unshift(['图生视频', makeVideo])
    actions.push(['复制图像', () => copyImage(false)], ['复制本地图片链接', () => copyImage(true)])
  }

  return <article className="work-card" onContextMenu={e => {
    if (e.shiftKey) return
    e.preventDefault()
    openMenu(e.clientX, e.clientY)
  }}>
    <button ref={card} className={'card' + (selected ? ' selected' : '')}
      aria-pressed={selected}
      aria-haspopup="menu"
      aria-expanded={!!menu}
      onClick={choose} onDoubleClick={inspect}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); inspect() }
        else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault()
          const rect = e.currentTarget.getBoundingClientRect()
          openMenu(rect.left + 12, rect.top + 12)
        }
      }}>
      {original ? (
        <div className="thumb">
          <img src={convertFileSrc(original)} alt="" decoding="async" onError={() => setFailedPreview(original)} />
        </div>
      ) : <LibraryThumbnail job={job} mode={performance} />}
      <b>{title}</b>
      <span className="work-card-meta">
        <em>{statusLabels[job.status] || job.status}</em>
        <small>{new Date(job.created).toLocaleDateString()} · {siteTemplate(job.model)?.Name || job.profileName}</small>
      </span>
    </button>
    {canUseImage && <button className="card-to-video" onClick={makeVideo} title="以这张图片作为视频首帧">图生视频 <span aria-hidden="true">↗</span></button>}
    {menu && createPortal(<div className="work-menu" role="menu" aria-label={job.kind === 'image' ? '图片作品操作' : '视频作品操作'} ref={popup}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation() }}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); setMenu(null); card.current?.focus(); return }
        const buttons = Array.from(e.currentTarget.querySelectorAll('button')), i = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault(); buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus()
        }
      }}>
      {actions.map(([label, action]) =>
        <button key={label} type="button" role="menuitem"
          onPointerDown={e => {
            if (e.button !== 0) return
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onClick={() => { setMenu(null); action() }}>{label}</button>)}
    </div>, document.body)}
  </article>
}
