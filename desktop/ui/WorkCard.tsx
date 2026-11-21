import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { siteTemplate, statusLabels, type JobView, type PerformanceMode } from '../shared'
import { LibraryThumbnail } from './LibraryThumbnail'

interface Props {
  performance: PerformanceMode
  job: JobView
  selected: boolean
  choose: () => void
  inspect: () => void
  makeVideo: () => void
  saveOriginal: () => void
  copyImage: (link: boolean) => void
}

export function WorkCard({ job, selected, choose, inspect, makeVideo, saveOriginal, copyImage, performance }: Props) {
  const card = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const canUseImage = job.kind === 'image' && job.status === 'done' && job.file && !!job.mediaPath
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
    const outside = (e: PointerEvent) => { if (!popup.current?.contains(e.target as Node)) close() }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  return <article className="work-card">
    <button ref={card} className={'card' + (selected ? ' selected' : '')}
      aria-haspopup={canUseImage ? 'menu' : undefined}
      onClick={choose} onDoubleClick={inspect}
      onContextMenu={e => {
        if (!canUseImage || e.shiftKey) return
        e.preventDefault()
        openMenu(e.clientX, e.clientY)
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); inspect() }
        else if (canUseImage && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
          e.preventDefault()
          const rect = e.currentTarget.getBoundingClientRect()
          openMenu(rect.left + 12, rect.top + 12)
        }
      }}>
      <LibraryThumbnail job={job} mode={performance} />
      <b>{title}</b><em>{statusLabels[job.status]}</em>
      <small>{new Date(job.created).toLocaleDateString()} · {siteTemplate(job.model)?.Name ?? job.profileName}</small>
    </button>
    {canUseImage && <button className="card-to-video" onClick={makeVideo} title="以这张图片作为视频首帧">图生视频 <span aria-hidden="true">↗</span></button>}
    {menu && createPortal(<div className="work-menu" role="menu" aria-label="图片作品操作" ref={popup}
      onContextMenu={e => e.preventDefault()}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setMenu(null) }}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); setMenu(null); card.current?.focus(); return }
        const buttons = Array.from(e.currentTarget.querySelectorAll('button')), i = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault(); buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus()
        }
      }}>
      {([['图生视频', makeVideo], ['查看作品', inspect], ['另存原文件', saveOriginal], ['复制图像', () => copyImage(false)], ['复制本地图片链接', () => copyImage(true)]] as const).map(([label, action]) =>
        <button key={label} role="menuitem" onClick={() => { setMenu(null); action() }}>{label}</button>)}
    </div>, document.body)}
  </article>
}
