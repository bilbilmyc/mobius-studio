import type { GifInfo, JobView } from '../shared'

export function isGif(job: JobView) {
  return Boolean(job.gif || (job.kind === 'image' && job.mediaPath && /\.gif$/i.test(job.mediaPath)))
}

function decimal(value: number) {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2, useGrouping: false })
}

export function gifTiming(frames: number, durationMs: number, variable = false) {
  const fps = durationMs > 0 ? (variable ? '平均 ' : '') + decimal(frames * 1000 / durationMs) + ' 帧/秒' : ''
  return [frames + ' 帧', fps, decimal(durationMs / 1000) + ' 秒/轮'].filter(Boolean).join(' · ')
}

export function gifSpecs(gif: GifInfo) {
  return gif.width + ' × ' + gif.height + ' · ' + gifTiming(gif.frames, gif.durationMs, gif.frameMs == null)
}
