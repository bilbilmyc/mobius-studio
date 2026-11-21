import { useEffect, useState } from 'react'
import type { JobView } from '../shared'
import { aspect, requestedAudio, requestedGeometry } from './outputSpecs'

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
  const seconds = Number(job.site?.config.duration ?? job.seconds)
  const request = [geometry && ('画幅 ' + geometry.ratio), geometry?.pixels?.join(' × '),
    video && seconds > 0 && (seconds + ' 秒'), video && sound !== undefined && (sound ? '生成音频' : '关闭生成音频')].filter(Boolean)
  return <div className="output-specs">
    {request.length > 0 && <p className="media-info">请求规格　{request.join(' · ')}</p>}
    {(metadata || video) && <p className="media-info">实际{video ? '视频' : '图片'} {metadata && (metadata.w + ' × ' + metadata.h + ' · ' + actual)}
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
