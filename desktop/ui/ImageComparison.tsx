import { useEffect, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  defaultConfig, isSite, mediaKind, officialModes, presets, profileModels, quote, relaySlots,
  siteTemplate, statusLabels, templates, type Comparison, type JobView, type Picked,
  type ProfileView, type Start, type Template,
} from '../shared'
import { Modal } from './Editor'
import { taskGuidance, useVisibleTime } from './taskHelp'

interface Option {
  key: string
  name: string
  price: string
  id: string
  model: string
  profile?: ProfileView
  template?: Template
}

export function comparisonOptions(profiles: ProfileView[], official: ProfileView | undefined,
  currentId: string, currentModel: string, mode: string, assets: Picked[]): Option[] {
  const options: Option[] = []
  const current = profiles.find(p => p.Id === currentId) ?? official
  const add = (id: string, model: string, name: string, price: string, p?: ProfileView, t?: Template) => {
    if (model === currentModel && (id === currentId || p?.BaseUrl === current?.BaseUrl)) return
    options.push({ key: JSON.stringify([id, model]), id, model, name, price, profile: p, template: t })
  }
  function officialOptions(id: string, p: ProfileView) {
    if (!p.hasKey) return
    for (const t of templates.filter(t => !t.Video && officialModes(t).includes(mode))) {
      if (mode === 'i2i' && assets.length > (t.Slots.find(s => s.Kind === 'image')?.Max ?? 0)) continue
      add(id, t.Key, (id === '@site' ? '官网' : p.Name) + ' · ' + t.Name, quote(t, defaultConfig(t), 0), p, t)
    }
  }
  if (official) officialOptions('@site', official)
  for (const p of profiles.filter(p => mediaKind(p.ProtocolId) === 'image')) {
    if (isSite(p.ProtocolId)) { officialOptions(p.Id, p); continue }
    const preset = presets[p.ProtocolId]
    if (!preset.modes?.includes(mode) && !p.Relay?.workflows?.[mode]) continue
    const slot = relaySlots(mode, preset.maxImages ?? 1, p.Relay?.workflows?.[mode]?.body)[0]
    if (slot && assets.length > slot.Max) continue
    for (const model of profileModels(p))
      add(p.Id, model, p.Name + ' · ' + model, p.ProtocolId === 'comfy-image' ? '本地运行' : '由服务商结算', p)
  }
  return options
}

export function peerInput(input: Start, option: Option, mode: string): Start {
  const p = option.profile!
  if (option.template) return { ...input, profileId: option.id, model: undefined,
    template: option.template.Key, config: defaultConfig(option.template), priority: 0 }
  if (input.profileId === option.id) return { ...input, model: option.model }
  const preset = presets[p.ProtocolId]
  const sizes = p.Relay?.sizes.length ? p.Relay.sizes : p.Controls?.sizes.length ? p.Controls.sizes : preset.sizes
  const resolutions = p.Controls?.resolutions.length ? p.Controls.resolutions : preset.resolutions ?? []
  const ratios = p.Controls?.ratios ?? []
  return { ...input, profileId: option.id, model: option.model, priority: 0, seconds: 0,
    size: sizes.includes(input.size) ? input.size : sizes[0],
    config: { mode, resolution: resolutions.includes(String(input.config.resolution)) ? input.config.resolution : resolutions[0] ?? '',
      ratio: ratios.includes(String(input.config.ratio)) ? input.config.ratio : ratios[0] ?? '' } }
}

export function ComparisonDialog({ group, jobs, close, selected, inspect }: {
  group: Comparison; jobs: JobView[]; close: () => void; selected: () => void; inspect: (job: JobView) => void
}) {
  const pair = group.jobIds.map(id => jobs.find(j => j.id === id))
  const now = useVisibleTime(pair.some(j => j && ['preparing', 'submitting', 'waiting', 'downloading'].includes(j.status)), 15000)
  const shot = pair.find(j => j?.shot)?.shot
  const [final, setFinal] = useState<string | null>(group.selected)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    let active = true
    if (shot) window.studio.scripts().then(scripts => {
      if (active) setFinal(scripts.find(s => s.id === shot.scriptId)?.finals[shot.sceneId]?.image ?? null)
    }).catch(e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [group.id, shot?.scriptId, shot?.sceneId])
  async function choose(job: JobView) {
    setBusy(true); setError('')
    try {
      await window.studio.selectComparison(group.id, job.id)
      setFinal(job.id); selected()
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  return <Modal wide title="双模型对比" close={close}>
    <div className="dialog-body comparison-body">
      {shot && <p>{shot.label}</p>}
      <p className="comparison-prompt">{pair.find(Boolean)?.prompt}</p>
      <div className="comparison-grid">
        {pair.map((job, i) => <section key={group.jobIds[i]} aria-label={'候选 ' + (i + 1)}>
          <h3>{job ? siteTemplate(job.model)?.Name ?? job.model : '准备候选'}</h3>
          <small>{job?.profileName} {job?.size}</small>
          {job?.file && job.mediaPath ? <img src={convertFileSrc(job.mediaPath)} alt={'候选图 ' + (i + 1)} />
            : <div className="comparison-state" role="status">{job ? statusLabels[job.status] ?? job.status : '正在载入'}
              {job?.detail && <small>{taskGuidance(job, now)?.title ?? job.detail}</small>}
              {job && <button className="link" onClick={() => inspect(job)}>查看任务详情</button>}</div>}
          <button disabled={busy || !job?.file || job.status !== 'done'} aria-pressed={final === job?.id}
            onClick={() => job && void choose(job)}>{final === group.jobIds[i] ? '已定稿' : '选为定稿'}</button>
        </section>)}
      </div>
      {error && <p role="alert" className="form-error">{error}</p>}
    </div>
  </Modal>
}
