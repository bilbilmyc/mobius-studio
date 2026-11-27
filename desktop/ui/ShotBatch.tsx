import { useEffect, useState } from 'react'
import { invoke } from './ipc'
import {
  defaultConfig,
  defaultTemplate,
  isSite,
  officialModes,
  presets,
  profileModels,
  siteTemplate,
  statusLabels,
  type MediaKind,
  type ProfileView,
  type Script,
  type ShotDraft,
  type Start,
  type State,
} from '../shared'
import { comparisonOptions, peerInput } from './ImageComparison'
import { frameOrder } from './Assets'
import { draftSubmission } from './draftSubmission'
import { Modal } from './Editor'

function localComfy(p?: ProfileView) {
  return (
    !!p &&
    p.ProtocolId === 'comfy-image' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(p.BaseUrl).hostname)
  )
}
function shotPlan(script: Script, index: number, kind: MediaKind, drafts: ShotDraft[], state: State) {
  const scene = script.scenes[index],
    shot = {
      scriptId: script.id,
      sceneId: scene.id,
      label: script.title + ' · 第 ' + (index + 1) + ' 镜',
    }
  const e = drafts.find(
    (d) => d.shot.scriptId === script.id && d.shot.sceneId === scene.id && d.kind === kind
  )?.editor
  const id = e?.service ?? '@site',
    profile = id === '@site' ? undefined : state.profiles.find((p) => p.Id === id)
  if (id !== '@site' && !profile) throw Error(shot.label + ' 的服务连接已移除。')
  const proto = profile?.ProtocolId ?? (kind === 'image' ? 'rh-image' : 'rh-video'),
    native = isSite(proto),
    preset = presets[proto]
  const t = siteTemplate(e?.templates[id] ?? '') ?? defaultTemplate(kind),
    model = profile ? e?.models[id] || profile.Model : undefined
  if (profile && !native && !profileModels(profile).includes(model!))
    throw Error(shot.label + ' 的模型已移除。')
  const key = JSON.stringify([id, kind, profile?.BaseUrl, native ? t.Key : model])
  const variant = e?.variants[key],
    config =
      variant?.config ??
      (native
        ? defaultConfig(t)
        : {
            mode: preset.modes?.[0] ?? 't2i',
            resolution: profile?.Controls?.resolutions?.[0] ?? preset.resolutions?.[0] ?? '',
            ratio: profile?.Controls?.ratios?.[0] ?? '',
          })
  const mixed = native && !t.Video && officialModes(t).length > 1
  const mode = String(
    config.mode ?? (mixed ? (variant?.intent ?? 't2i') : native ? 'default' : preset.modes?.[0])
  )
  const assets = variant?.byMode[mode] ?? [],
    intent = native && !officialModes(t).includes(mode) ? (variant?.intent ?? officialModes(t)[0]) : mode
  const features = state.modelFeatures?.[[id, profile?.BaseUrl, model].join('|')]
  const input: Start = {
    shot,
    profileId: id,
    kind,
    template: t.Key,
    model: native ? undefined : model,
    prompt:
      !e || e.prompt === e.scriptPrompt
        ? kind === 'image'
          ? scene.imagePrompt
          : scene.videoPrompt
        : e.prompt,
    config,
    size: variant?.size ?? profile?.Relay?.sizes[0] ?? profile?.Controls?.sizes[0] ?? preset.sizes[0],
    seconds: variant?.seconds ?? profile?.Controls?.seconds[0] ?? preset.seconds[0] ?? 0,
    priority: variant?.priority ?? 0,
    ...draftSubmission(
      variant,
      mode,
      mode === 'first_last' ? frameOrder(assets) : assets,
      kind === 'image' ? (variant?.count ?? 1) : 1,
      proto,
      features?.multi
    ),
  }
  const others = state.profiles.filter(
    (p) => !isSite(p.ProtocolId) || p.BaseUrl !== state.official.BaseUrl
  )
  const peers =
    kind === 'image'
      ? comparisonOptions(
          others,
          state.official,
          id,
          native ? t.Key : model!,
          intent,
          assets,
          input,
          state.modelFeatures
        )
      : []
  return { input, peers, compare: e?.compare ?? '', name: native ? t.Name : (model ?? ''), native, profile }
}
interface BatchItem {
  id: string
  model: string
  shot?: { scriptId: string; sceneId: string; label: string }
  status: string
  priority?: number
}
interface Batch {
  id: string
  running: boolean
  limit: number
  jobs: BatchItem[]
}
export function ShotBatch({
  script,
  close,
  flush,
}: {
  script: Script
  close: () => void
  flush: () => Promise<void>
}) {
  const [data, setData] = useState<{ state: State; drafts: ShotDraft[] }>(),
    [batches, setBatches] = useState<Batch[]>([])
  const [kind, setKind] = useState<MediaKind>('image'),
    [skip, setSkip] = useState<string[]>([]),
    [choices, setChoices] = useState<Record<string, string>>({})
  const [limit, setLimit] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const refresh = () => invoke<Batch[]>('list_batches').then(setBatches)
  useEffect(() => {
    let alive = true
    void flush()
      .then(() => Promise.all([window.studio.state(), window.studio.shotDrafts()]))
      .then(([state, drafts]) => {
        if (alive) setData({ state, drafts })
      })
      .catch((e) => setError(String(e)))
    void refresh().catch((e) => setError(String(e)))
    const off = window.studio.changed(() => {
      if (alive) void refresh().catch((e) => setError(String(e)))
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  const plans = script.scenes.map((s, i) => {
    try {
      return data ? shotPlan(script, i, kind, data.drafts, data.state) : undefined
    } catch (ex) {
      return String(ex)
    }
  })
  const inputs: Start[] = []
  let missingPeer = false
  const rows = plans.map((plan, i) => {
    const scene = script.scenes[i],
      on = !skip.includes(scene.id)
    if (!plan || typeof plan === 'string')
      return (
        <li key={scene.id}>
          <label>
            <input
              type="checkbox"
              checked={on}
              onChange={() => setSkip(on ? [...skip, scene.id] : skip.filter((s) => s !== scene.id))}
            />
            {scene.heading}
          </label>
          {plan}
        </li>
      )
    const value = choices[kind + scene.id] ?? plan.compare,
      peer = plan.peers.find((p) => p.key === value)
    if (on && value && !peer) missingPeer = true
    if (on) {
      const primary = peer ? { ...plan.input, count: 1, repeat: 1 } : plan.input
      inputs.push(primary)
      if (peer) inputs.push(peerInput(primary, peer))
    }
    const times = peer ? 2 : (plan.input.repeat ?? 1),
      outputs = peer ? 2 : Math.max(plan.input.count ?? 1, times)
    const execution = plan.native
      ? (plan.input.priority ? '优先队列' : '普通队列')
      : localComfy(plan.profile) ? '本地运行' : plan.profile?.Name
    return (
      <li key={scene.id}>
        <label>
          <input
            type="checkbox"
            checked={on}
            onChange={() => setSkip(on ? [...skip, scene.id] : skip.filter((s) => s !== scene.id))}
          />
          第 {i + 1} 镜 · {scene.heading} · {times} 次提交 · {outputs} 个结果
        </label>
        <small>{[plan.name, execution].filter(Boolean).join(' · ')}</small>
        {(plan.peers.length > 0 || value) && (
          <label>
            第二模型
            <select
              value={value}
              onChange={(e) => setChoices({ ...choices, [kind + scene.id]: e.target.value })}
            >
              <option value="">仅用主模型</option>
              {value && !peer && (
                <option value={value} disabled>
                  原对比模型不可用，请重选
                </option>
              )}
              {plan.peers.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                  {p.template ? (p.parameters.priority ? ' · 优先队列' : ' · 普通队列') : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </li>
    )
  })
  const submitCount = inputs.reduce((total, input) => total + (input.repeat ?? 1), 0)
  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try {
      await fn()
      await refresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal wide title="镜头队列" close={close}>
      <div className="project-tools">
        <label>
          媒体类型
          <select value={kind} onChange={(e) => setKind(e.target.value as MediaKind)}>
            <option value="image">图片</option>
            <option value="video">视频</option>
          </select>
        </label>
        {data ? <ol>{rows}</ol> : <p role="status">正在读取各镜草稿和模型参数…</p>}
        {data && <p>共 {submitCount} 次提交</p>}
        <label>
          每个连接同时执行
          <input
            type="number"
            min="1"
            max="8"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          />
        </label>
        <button
          disabled={
            busy ||
            missingPeer ||
            !inputs.length ||
            plans.some((p, i) => !skip.includes(script.scenes[i].id) && typeof p === 'string')
          }
          onClick={() =>
            void act(() => invoke('create_batch', { inputs, limit }))
          }
        >
          加入待发清单
        </button>
        {batches
          .filter((b) => b.jobs.some((j) => j.shot?.scriptId === script.id))
          .map((b) => (
            <section key={b.id}>
              <h3>批次 {b.id.slice(0, 8)}</h3>
              <ul>
                {b.jobs.map((j) => (
                  <li key={j.id}>
                    {script.title} ·{' '}
                    {script.scenes.findIndex((scene) => scene.id === j.shot?.sceneId) >= 0
                      ? '第 ' +
                        (script.scenes.findIndex((scene) => scene.id === j.shot?.sceneId) + 1) +
                        ' 镜'
                      : '已移除镜头'}{' '}
                    · {siteTemplate(j.model)?.Name ?? j.model} · {statusLabels[j.status] ?? j.status}
                    {j.status === 'queued' && (
                      <button
                        disabled={busy}
                        onClick={() => void act(() => invoke('withdraw_job', { id: j.id }))}
                      >
                        撤回
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {!b.running && b.jobs.some((j) => j.status === 'queued') && (
                <button
                  disabled={busy}
                  className="primary"
                  onClick={() => void act(() => invoke('run_batch', { id: b.id }))}
                >
                  开始发送
                </button>
              )}
            </section>
          ))}
        {error && <p role="alert">{error}</p>}
      </div>
    </Modal>
  )
}
