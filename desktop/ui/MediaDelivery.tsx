import { useEffect, useState } from 'react'
import type { JobView } from '../shared'
import { aspect, requestedAudio, requestedGeometry } from './outputSpecs'
import { gifSpecs, gifTiming, isGif } from './gifInfo'

export interface MediaMetadata { id: string; w: number; h: number; duration?: number }

export function OutputSpecs({ job, metadata }: { job: JobView; metadata?: MediaMetadata }) {
  const [audio, setAudio] = useState<number>()
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)
  const video = job.kind === 'video'
  useEffect(() => {
    if (!video) return
    let active = true
    import('./videoTracks').then(m => m.countAudioTracks(job.id)).then(count => {
      if (active) setAudio(count)
    }).catch(e => { if (active) setError('无法读取音轨信息。' + String(e)) })
    return () => { active = false }
  }, [job.id, video])
  async function exportSilent() {
    setBusy(true)
    setError('')
    try { setSaved(await (await import('./videoTracks')).exportSilentVideo(job.id)) }
    catch (e) { setError('无音轨副本导出失败。' + String(e)) }
    finally { setBusy(false) }
  }
  const geometry = requestedGeometry(job)
  const actual = metadata && aspect(metadata.w, metadata.h)
  const differentRatio = geometry && actual && geometry.ratio !== actual
  const differentPixels = geometry?.pixels && metadata && (geometry.pixels[0] !== metadata.w || geometry.pixels[1] !== metadata.h)
  const sound = requestedAudio(job)
  const gif = job.gif
  const requestedGif = job.settings?.output_format === 'gif'
  const frames = Number(job.settings?.frame_count)
  const delay = Number(job.settings?.frame_duration_ms)
  const seconds = Number(job.site?.config.duration ?? job.seconds)
  const request = [geometry && ('画幅 ' + geometry.ratio), geometry?.pixels?.join(' × '),
    video && seconds > 0 && (seconds + ' 秒'), video && sound !== undefined && (sound ? '生成音频' : '关闭生成音频')].filter(Boolean)
  return <div className="output-specs">
    {requestedGif && frames > 0 && delay > 0 && <p className="media-info">请求 GIF　{gifTiming(frames, frames * delay)}</p>}
    {gif && <p className="media-info">实际 GIF　{gifSpecs(gif)} · {gif.repeats == null ? '播放一次' : gif.repeats === 0 ? '无限循环' : '重复 ' + gif.repeats + ' 次'}</p>}
    {requestedGif && job.file && !isGif(job) && <p className="spec-note">已请求 GIF 动图，服务返回了静态图片。</p>}
    {requestedGif && gif && (gif.frames !== frames || gif.frameMs !== delay) && <p className="spec-note">返回文件的帧数或帧间隔与请求不同。</p>}
    {isGif(job) && !gif && <p className="spec-note">无法读取 GIF 帧信息。</p>}
    {request.length > 0 && <p className="media-info">请求规格　{request.join(' · ')}</p>}
    {!gif && (metadata || video) && <p className="media-info">实际{video ? '视频' : '图片'} {metadata && (metadata.w + ' × ' + metadata.h + ' · ' + actual)}
      {Number.isFinite(metadata?.duration) && ' · ' + metadata!.duration!.toFixed(2) + ' 秒'}
      {video && (audio !== undefined ? (audio ? ' · ' + audio + ' 条音轨' : ' · 无音轨') : (error ? '' : ' · 正在读取音轨…'))}</p>}
    {(differentRatio || differentPixels) && <p className="spec-note">原文件{differentRatio ? '画幅' : '像素尺寸'}与请求不同。{!video && '可用「按尺寸导出」裁切或补边。'}</p>}
    {video && sound === false && !!audio && <p className="spec-note">已请求关闭生成音频，上游返回的视频仍含音轨。预览默认静音。</p>}
    {video && sound === true && audio === 0 && <p className="spec-note">已请求生成音频，上游返回的视频没有音轨。</p>}
    {video && !!audio && <button disabled={busy} onClick={() => void exportSilent()}>{busy ? '正在导出…' : '导出无音轨副本'}</button>}
    {saved && <p className="media-info" role="status">无音轨副本已保存到 {saved}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </div>
}
