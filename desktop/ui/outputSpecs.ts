import type { JobView } from '../shared'

type Dimensions = [number, number]

export function aspect(w: number, h: number) {
  let a = w, b = h
  while (b) [a, b] = [b, a % b]
  return a ? w / a + ':' + h / a : ''
}

export function fitSize(w: number, h: number, ratio: string): Dimensions {
  const [x, y] = ratio.split(':').map(Number)
  if (!(x > 0 && y > 0)) return [w, h]
  const [a, b] = aspect(x, y).split(':').map(Number)
  const scale = Math.max(1, Math.floor(Math.min(w / a, h / b)))
  return [a * scale, b * scale]
}

export function requestedGeometry(job: JobView): { ratio: string; pixels?: Dimensions } | undefined {
  const config = job.site?.config ?? job.settings ?? {}
  const size = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(job.size?.trim())
  const pixels: Dimensions | undefined = size && Number(size[1]) > 0 && Number(size[2]) > 0
    ? [Number(size[1]), Number(size[2])] : undefined
  for (const candidate of [config.aspect, config.ratio, job.size]) {
    const pair = /^(\d+)\s*:\s*(\d+)$/.exec(String(candidate ?? '').trim())
    if (!pair || !(+pair[1] && +pair[2])) continue
    const ratio = aspect(+pair[1], +pair[2])
    return { ratio, pixels: pixels && aspect(...pixels) === ratio ? pixels : undefined }
  }
  return pixels ? { ratio: aspect(...pixels), pixels } : undefined
}

export function requestedAudio(job: JobView): boolean | undefined {
  const value = (job.site?.config ?? job.settings)?.generate_audio
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
}
