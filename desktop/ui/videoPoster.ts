import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import type { JobView } from '../shared'

export async function videoPoster(job: JobView, signal: AbortSignal) {
  const { path, stamp } = await invoke<{ path: string | null; stamp: string }>('video_poster', {
    id: job.id,
  })
  if (path) return path
  if (signal.aborted) throw Error('停止读取视频封面')
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.crossOrigin = 'anonymous'
  video.preload = 'auto'
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        video.onloadeddata = video.onseeked = video.onerror = null
        if (error) reject(error)
        else resolve()
      }
      const abort = () => finish(Error('停止读取视频封面'))
      const timeout = setTimeout(() => finish(Error('视频封面读取超时')), 6000)
      signal.addEventListener('abort', abort, { once: true })
      video.onerror = () => finish(Error('系统无法读取视频封面'))
      video.onloadeddata = () => {
        if (video.duration > 0 && Number.isFinite(video.duration)) {
          video.onseeked = () => finish()
          video.currentTime = Math.min(0.1, video.duration / 2)
        } else finish()
      }
      video.src = job.mediaUrl ?? convertFileSrc(job.mediaPath!)
    })
    if (!video.videoWidth || !video.videoHeight) throw Error('视频缺少画面')
    const ratio = Math.min(1, 384 / Math.max(video.videoWidth, video.videoHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(video.videoWidth * ratio))
    canvas.height = Math.max(1, Math.round(video.videoHeight * ratio))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw Error('系统无法绘制封面')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(Error('封面编码失败'))), 'image/png'),
    )
    if (signal.aborted) throw Error('停止读取视频封面')
    return await invoke<string>('save_video_poster', new Uint8Array(await png.arrayBuffer()), {
      headers: { 'x-job-id': job.id, 'x-source-stamp': stamp },
    })
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}
