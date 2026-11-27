import { useCallback, useEffect, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { modeLabels, siteTemplate, type JobView, type Value } from '../shared'
import { Modal } from './Editor'
import { gifSpecs, isGif } from './gifInfo'

const fieldLabels: Record<string, string> = {
  mode: '创作方式', output_format: '输出格式', frame_count: '帧数', frame_duration_ms: '每帧时长（毫秒）',
  quality: '图片质量', ratio: '画幅', resolution: '分辨率', seed: '种子', duration: '时长（秒）',
}

function parameters(job: JobView) {
  const values = new Map<string, string>()
  const template = siteTemplate(job.model)
  values.set('提示词', job.prompt)
  values.set('渠道', job.profileName)
  values.set('模型', template?.Name || job.model)
  if (job.size) values.set('请求尺寸', job.size)
  if (job.seconds) values.set('时长（秒）', String(job.seconds))
  if (job.site) values.set('队列', String(job.site.priority))
  const config: Record<string, Value> = { ...job.settings, ...job.site?.config }
  for (const [key, raw] of Object.entries(config)) {
    if (raw == null || raw === '') continue
    const field = template?.Fields.find(f => f.Key === key)
    const label = field?.Label || fieldLabels[key] || key.replace(/^params\./, '')
    const value = field?.Options?.find(o => o.Value === raw)?.Label
      ?? (key === 'mode' ? modeLabels[String(raw)] : undefined)
      ?? (typeof raw === 'boolean' ? (raw ? '开启' : '关闭') : typeof raw === 'object' ? JSON.stringify(raw) : String(raw))
    values.set(label, value)
  }
  return values
}

export function WorkComparison({ pair, close }: { pair: [JobView, JobView]; close: () => void }) {
  const media = useRef<(HTMLImageElement | HTMLVideoElement | null)[]>([])
  const [loaded, setLoaded] = useState([false, false])
  const [error, setError] = useState('')
  const bothReady = loaded.every(Boolean)
  const moving = pair.some(j => isGif(j) || j.kind === 'video')
  const fields = pair.map(parameters)
  const differences = [...new Set([...fields[0].keys(), ...fields[1].keys()])]
    .filter(key => fields[0].get(key) !== fields[1].get(key))

  const replay = useCallback(() => {
    media.current.forEach(el => {
      if (el instanceof HTMLVideoElement) {
        el.currentTime = 0
        void el.play().catch(() => setError('视频未能播放，可在预览中手动播放。'))
      } else if (el?.dataset.animated === 'true') {
        // Assigning the image source again restarts GIF playback, including a completed finite loop.
        el.src = el.src
      }
    })
  }, [])
  useEffect(() => {
    if (bothReady && moving) replay()
  }, [bothReady, moving, replay])
  const ready = (i: number) => setLoaded(old => old[i] ? old : old.map((value, index) => index === i || value))

  return <Modal wide title="作品对比" close={close}>
    <div className="dialog-body version-comparison">
      <div className="comparison-grid">
        {pair.map((j, i) => {
          const label = i === 0 ? '版本 A' : '版本 B'
          const url = j.mediaUrl ?? convertFileSrc(j.mediaPath!)
          const failed = () => setError(label + ' 的原文件无法预览。')
          return <section key={j.id} aria-label={label}>
            <h3>{label}</h3>
            <small>{new Date(j.created).toLocaleString()} · {j.profileName}</small>
            {j.kind === 'video' ? <video ref={el => { media.current[i] = el }} src={url} controls muted loop
              preload="auto" onLoadedData={() => ready(i)} onError={failed} aria-label={label} />
              : <img ref={el => { media.current[i] = el }} alt={label} src={url} data-animated={isGif(j)}
                onLoad={() => ready(i)} onError={failed} />}
            {j.gif && <small>GIF · {gifSpecs(j.gif)}</small>}
          </section>
        })}
      </div>
      {moving && <button type="button" disabled={!bothReady} onClick={replay}>同时从头播放</button>}
      {error && <p role="alert">{error}</p>}
      {differences.length ? <table className="version-diff">
        <caption>提示词与参数差异</caption>
        <thead><tr><th scope="col">项目</th><th scope="col">版本 A</th><th scope="col">版本 B</th></tr></thead>
        <tbody>{differences.map(key => <tr key={key}><th scope="row">{key}</th>
          <td>{fields[0].get(key) || '—'}</td><td>{fields[1].get(key) || '—'}</td></tr>)}</tbody>
      </table> : <p>这两版的提示词和生成参数相同。</p>}
    </div>
  </Modal>
}
