import { useEffect, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { JobView, PerformanceMode } from '../shared'
import { videoPoster } from './videoPoster'

type ObserverGroup = {
  observer: IntersectionObserver
  callbacks: Map<Element, (near: boolean) => void>
}
const groups = new WeakMap<Element, Map<string, ObserverGroup>>()
function observe(node: Element, mode: PerformanceMode, change: (near: boolean) => void) {
  const root = node.closest('.asset-library, .page-body') ?? document.documentElement
  const margin = { eco: '0px', auto: '96px', performance: '192px' }[mode]
  const margins = groups.get(root) ?? new Map<string, ObserverGroup>()
  groups.set(root, margins)
  let group = margins.get(margin)
  if (!group) {
    const callbacks: ObserverGroup['callbacks'] = new Map()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting)
      },
      { root, rootMargin: margin + ' 0px' },
    )
    group = { observer, callbacks }
    margins.set(margin, group)
  }
  group.callbacks.set(node, change)
  group.observer.observe(node)
  return () => {
    group.observer.unobserve(node)
    group.callbacks.delete(node)
    if (!group.callbacks.size) {
      group.observer.disconnect()
      margins.delete(margin)
    }
  }
}

// Skip thumbnails that left the viewport while the two decoders were busy.
const queue = new Set<() => Promise<void>>()
let decoding = 0
function drain() {
  while (decoding < 2 && queue.size) {
    const next = queue.values().next().value!
    queue.delete(next)
    decoding++
    void next().finally(() => {
      decoding--
      drain()
    })
  }
}

export function LibraryThumbnail({ job, mode = 'auto' }: { job: JobView; mode?: PerformanceMode }) {
  const box = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false),
    [loaded, setLoaded] = useState<{ key: string; url: string }>()
  const key = job.id + '/' + (job.mediaPath ?? '')
  const url = loaded?.key === key ? loaded.url : undefined
  useEffect(() => (box.current ? observe(box.current, mode, setNear) : undefined), [mode])
  useEffect(() => {
    if (!near && url === '') {
      setLoaded(undefined)
      return
    }
    if (!near || !job.file || url !== undefined) return
    let current = true
    const stop = new AbortController()
    const load = async () => {
      try {
        const path =
          job.kind === 'image'
            ? await window.studio.thumbnail(job.id)
            : await videoPoster(job, stop.signal)
        if (current) setLoaded({ key, url: convertFileSrc(path) })
      } catch {
        if (current) setLoaded({ key, url: '' })
      }
    }
    queue.add(load)
    drain()
    return () => {
      current = false
      queue.delete(load)
      stop.abort()
    }
  }, [near, job.id, job.file, job.kind, key, url])
  return (
    <div className="thumb" ref={box}>
      {near && job.file && job.mediaPath && job.kind === 'video' && url === '' ? (
        <video
          src={(job.mediaUrl ?? convertFileSrc(job.mediaPath)) + '#t=0.1'}
          muted
          preload="metadata"
        />
      ) : near && url ? (
        <img src={url} alt="" decoding="async" />
      ) : (
        <span>{url === '' ? '缩略图不可用' : job.kind === 'video' ? '视频' : '图片'}</span>
      )}
    </div>
  )
}
