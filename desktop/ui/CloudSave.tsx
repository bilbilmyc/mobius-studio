import { useState } from 'react'
import type { Integrations, JobView } from '../shared'

interface Props {
  job: JobView
  settings?: Integrations
  configure: () => void
  report: (message: string) => void
}

export function CloudSave({ job, settings, configure, report }: Props) {
  const [busy, setBusy] = useState(false)
  if (!job.file || job.kind !== 'image') return null
  const copy = job.cloud, target = settings?.storage
  const working = busy || copy?.status === 'pending' || copy?.status === 'uploading'
  const prefix = target?.prefix ? target.prefix + '/' : ''
  const scheme = { aliyun: 'oss', tencent: 'cos', volcengine: 'tos', aws: 's3', s3: 's3' }[target?.provider ?? 's3']
  const savedHere = copy?.status === 'saved' && copy.endpoint === target?.endpoint &&
    copy.uri.startsWith(`${scheme}://${target?.bucket}/${prefix}${job.id}.`)
  return <div className="cloud-save">
    {copy?.status === 'saved' && <span className="cloud-location">已上传 · {copy.uri}</span>}
    {copy?.status === 'failed' && <span role="status" className="error">{copy.detail}</span>}
    {!savedHere && <button disabled={working} onClick={async () => {
      if (!settings?.hasStorageKey) { configure(); return }
      setBusy(true)
      try { await window.studio.uploadImage(job.id); report('图片已保存到对象存储。') }
      catch (e) { report(String(e)) }
      finally { setBusy(false) }
    }}>{working ? '正在上传…' : copy?.status === 'failed' ? '重试上传' : '存到对象存储'}</button>}
  </div>
}
