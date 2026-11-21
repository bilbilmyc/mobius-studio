import { useEffect, useRef, useState } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import type { JobView, Picked, Script, ShotLink } from '../shared'
import { Modal } from './Editor'
async function captureCurrent(video: HTMLVideoElement, id: string, seconds: number): Promise<Picked> {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx || !canvas.width || !canvas.height) throw Error('当前帧未加载。')
    ctx.drawImage(video, 0, 0)
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(Error('当前帧读取失败。'))), 'image/png')
    )
    return await invoke<Picked>('save_captured_frame', new Uint8Array(await blob.arrayBuffer()))
  } catch {
    return invoke<Picked>('extract_frame', { id, seconds })
  }
}
export type NextFrame = (job: JobView, motion: string, pick?: Picked, target?: ShotLink) => Promise<void>
export function FilmPreview({
  script,
  jobs,
  close,
  frame,
  locate,
}: {
  script: Script
  jobs: JobView[]
  close: () => void
  frame: NextFrame
  locate: (id: string) => void
}) {
  const clips = script.scenes.map((s) => jobs.find((j) => j.id === script.finals[s.id]?.video && j.file))
  const key = clips.map((j) => j?.id ?? '').join('/')
  const [durations, setDurations] = useState<Record<string, number>>({}),
    [index, select] = useState(0),
    [playing, play] = useState(false)
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  const player = useRef<HTMLVideoElement>(null),
    job = clips[index],
    next = script.scenes[index + 1]
  useEffect(() => {
    let mounted = true
    setDurations({})
    void (async () => {
      const { measuredDuration } = await import('./videoTracks')
      for (const clip of clips)
        if (clip) {
          const value = await measuredDuration(clip.id)
          if (mounted) setDurations((old) => ({ ...old, [clip.id]: value }))
        }
    })().catch((e) => {
      if (mounted) setMessage(String(e))
    })
    return () => {
      mounted = false
    }
  }, [key])
  async function act(fn: () => Promise<void>) {
    setBusy(true)
    setMessage('')
    try {
      await fn()
    } catch (e) {
      setMessage(String(e))
    } finally {
      setBusy(false)
    }
  }
  const ready = clips.every((j) => j && durations[j.id] > 0)
  const total = Object.values(durations).reduce((a, b) => a + b, 0)
  return (
    <Modal wide title="整片预览与交付" close={close}>
      <div className="project-tools">
        <h3>{script.title}</h3>
        <ol>
          {clips.map((j, i) => (
            <li key={script.scenes[i].id}>
              <button
                onClick={() => {
                  if (!j) {
                    locate(script.scenes[i].id)
                    return
                  }
                  select(i)
                  play(false)
                }}
              >
                {script.scenes[i].heading} ·{' '}
                {j ? (durations[j.id]?.toFixed(2) ?? '…') + ' 秒' : '缺少视频，定位到此镜'}
              </button>
            </li>
          ))}
        </ol>
        <p>
          {ready
            ? '总时长 ' + total.toFixed(2) + ' 秒'
            : '已有 ' + clips.filter(Boolean).length + ' / ' + clips.length + ' 镜'}
        </p>
        {job && (
          <video
            key={job.id}
            ref={player}
            playsInline
            controls
            preload="metadata"
            src={job.mediaUrl ?? convertFileSrc(job.mediaPath!)}
            onLoadedData={() => {
              if (playing)
                void player.current?.play().catch((e) => {
                  play(false)
                  setMessage(String(e))
                })
            }}
            onEnded={() => {
              if (playing && index + 1 < clips.length) select(index + 1)
              else play(false)
            }}
          />
        )}
        <div className="project-actions">
          <button
            disabled={!ready}
            onClick={() => {
              select(0)
              play(true)
              if (index === 0 && player.current) {
                player.current.currentTime = 0
                void player.current.play().catch((e) => setMessage(String(e)))
              }
            }}
          >
            从头顺序播放
          </button>
          {job && next && (
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const seconds = Math.max(
                    0,
                    Math.min(player.current?.currentTime ?? 0, (durations[job.id] ?? Infinity) - 0.05)
                  )
                  const pick = await captureCurrent(player.current!, job.id, seconds)
                  await frame(job, next.videoPrompt, pick, {
                    scriptId: script.id,
                    sceneId: next.id,
                    label: script.title + ' · 第 ' + (index + 2) + ' 镜',
                  })
                  close()
                })
              }
            >
              取当前帧作为下一镜首帧
            </button>
          )}
        </div>
        <div className="project-actions">
          {[false, true].map((combine) => (
            <button
              key={String(combine)}
              disabled={busy || !ready}
              onClick={() =>
                void act(async () => {
                  setMessage(
                    '已导出至 ' +
                      (await invoke<string>('deliver_film', { scriptId: script.id, combine }))
                  )
                })
              }
            >
              {combine ? '合成 MP4' : '导出分镜文件与台词'}
            </button>
          ))}
        </div>
        {busy && <p role="status">正在处理媒体…</p>}
        {message && <p role="status">{message}</p>}
      </div>
    </Modal>
  )
}
