import { useEffect, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  defaultConfig, isSite, mediaKind, officialModes, presets, profileModels, profileSizes, quote, relaySlots,
  siteTemplate, statusLabels, templates, type Comparison, type JobView, type Picked,
  type ProfileView, type Start, type State, type Template,
} from '../shared'
import { Modal } from './Editor'
import { taskGuidance, useVisibleTime } from './taskHelp'
import { aspect } from './outputSpecs'

type Parameters = Pick<Start, 'size' | 'config' | 'priority'>
function imageRatio({ size, config }: Parameters) {
  if (config.aspect || config.ratio) return String(config.aspect || config.ratio)
  const pixels = /^(\d+)x(\d+)$/i.exec(size)
  return pixels ? aspect(+pixels[1], +pixels[2]) : size
}

export function comparisonSpecs(parameters: Parameters, official: boolean) {
  const { size, config, priority } = parameters
  return [...new Set([imageRatio(parameters), !official && size, config.resolution,
    official && (priority ? '高优先级队列' : '普通队列')].filter(Boolean))].join(' · ')
}

interface Option {
  key: string
  name: string
  price: string
  parameters: Parameters
  id: string
  model: string
  profile?: ProfileView
  template?: Template
}

export function comparisonOptions(profiles: ProfileView[], official: ProfileView | undefined,
  currentId: string, currentModel: string, mode: string, assets: Picked[], primary: Parameters, features?:State['modelFeatures']): Option[] {
  const options: Option[] = []
  const current = profiles.find(p => p.Id === currentId) ?? official
  const add = (id: string, model: string, name: string, price: string, parameters: Parameters, p: ProfileView, t?: Template) => {
    if (model === currentModel && (id === currentId || p?.BaseUrl === current?.BaseUrl)) return
    options.push({ key: JSON.stringify([id, model]), id, model, name, price, parameters, profile: p, template: t })
  }
  function officialOptions(id: string, p: ProfileView) {
    if (!p.hasKey) return
    for (const t of templates.filter(t => !t.Video && officialModes(t).includes(mode))) {
      if (mode === 'i2i' && assets.length > (t.Slots.find(s => s.Kind === 'image')?.Max ?? 0)) continue
      const config = defaultConfig(t)
      for (const field of t.Fields) {
        const requested = ['aspect', 'ratio'].includes(field.Key) ? imageRatio(primary) : primary.config[field.Key]
        if (field.Options?.some(o => o.Value === requested)) config[field.Key] = requested
      }
      const parameters = { config, size: String(config.aspect ?? config.ratio ?? primary.size), priority: primary.priority }
      add(id, t.Key, (id === '@site' ? '官网' : p.Name) + ' · ' + t.Name, quote(t, config, parameters.priority), parameters, p, t)
    }
  }
  if (official) officialOptions('@site', official)
  for (const p of profiles.filter(p => mediaKind(p.ProtocolId) === 'image')) {
    if (isSite(p.ProtocolId)) { officialOptions(p.Id, p); continue }
    const preset = presets[p.ProtocolId]
    if (!preset.modes?.includes(mode) && !p.Relay?.workflows?.[mode]) continue
    const resolutions = p.Controls?.resolutions.length ? p.Controls.resolutions : preset.resolutions ?? []
    const ratios = p.Controls?.ratios ?? [], ratio = imageRatio(primary)
    for (const model of profileModels(p)) {
      const declared=features?.[[p.Id,p.BaseUrl,model].join('|')]
      const slot=relaySlots(mode,declared?.maxImages??preset.maxImages??1,p.Relay?.workflows?.[mode]?.body)[0]
      if (slot && assets.length > slot.Max) continue
      const sizes=profileSizes(p, model, declared?.sizes)
      const size=[primary.size,ratio].find(v=>sizes.includes(v))??sizes[0]
      const allowCustom = p.Controls?.customSize && !declared?.sizes.length && /^\d+x\d+$/.test(primary.size)
      const parameters=p.Id===currentId?{...primary,size:allowCustom?primary.size:size}:{
        size,config:{mode,resolution:resolutions.includes(String(primary.config.resolution))?primary.config.resolution:resolutions[0]??'',
          ratio:ratios.includes(ratio)?ratio:ratios[0]??''},priority:0}
      add(p.Id,model,p.Name+' · '+model,p.ProtocolId==='comfy-image'?'由所连 ComfyUI 运行':'由服务商结算',parameters,p)
    }
  }
  return options
}

export function peerInput(input: Start, option: Option): Start {
  return { ...input, ...option.parameters, profileId: option.id, model: option.template ? undefined : option.model,
    template: option.template?.Key ?? input.template, seconds: 0 }
}

export function ComparisonDialog({ group, jobs, close, selected, inspect, background }: {
  group: Comparison; jobs: JobView[]; close: () => void; selected: () => void; inspect: (job: JobView) => void
  background: () => void
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
    {pair.some(job => !job || ['queued', 'preparing', 'submitting', 'waiting', 'downloading'].includes(job.status)) &&
      <footer className="modal-actions"><button onClick={background}>转入后台</button></footer>}
  </Modal>
}
