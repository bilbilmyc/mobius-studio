import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { convertFileSrc } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import './bridge'
import './studio.css'
import './workspace.css'
import orbit from '../../src/orbit.png'
import {
  defaultConfig,
  modeLabels,
  officialModes,
  relaySlots,
  defaultTemplate,
  isSite,
  mediaKind,
  profileModels,
  presets,
  quote,
  siteBase,
  siteTemplate,
  slots,
  statusLabels,
  templates,
  type JobView,
  type ShotLink,
  type Integrations,
  type Kind,
  type MediaKind,
  type Picked,
  type ProfileView,
  type Slot,
  type Value,
} from '../shared'
import { Modal, Prompt } from './Editor'
import { ImageExport, aspect } from './ImageExport'
import { ParameterField } from './ProtocolSettings'
import { ConnectionEditor } from './ConnectionEditor'
import { Assets, addAssets, frameOrder } from './Assets'
import { Settings, type SettingsSection } from './Settings'
import { ScriptDesk } from './ScriptDesk'
import { CloudSave } from './CloudSave'
import { JobPreviewState } from './JobPreviewState'
import { BackgroundTasks, jobAction } from './BackgroundTasks'
import { WorkLibrary, defaultLibraryView } from './WorkLibrary'
import { ComfyControls } from './ComfyControls'
import { useStudioState } from './useStudioState'
const example = {
  image:
    '一条带有细密刻纹的钛金属带扭转成莫比乌斯环，悬在黑曜石台面上。左侧冰蓝、右侧紫罗兰色的轮廓光勾出曲面，低机位产品摄影。',
  video:
    '镜头从金属带的细纹缓慢拉远，绕着悬浮的莫比乌斯环移动。冰蓝色高光沿扭面滑向紫光，最后停在环身与倒影交叠的一刻。',
}
const icons = {
  create: 'M4 8V4h4m8 0h4v4m0 8v4h-4M8 20H4v-4m4-4h8m-4-4v8',
  library: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  script: 'M5 3h13v18H5zM8 7h7M8 11h7M8 15h4',
  settings: 'M3 6h8m4 0h6M3 12h2m4 0h12M3 18h11m4 0h3M11 3v6M7 9v6m9 0v6',
}
function Icon({ name }: { name: keyof typeof icons }) {
  return (
    <svg
      width="23"
      height="23"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={icons[name]} />
    </svg>
  )
}
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
interface Draft {
  config: Record<string, Value>
  priority: number
  size: string
  seconds: number
  manualSize?: boolean
  intent?: string
  byMode: Record<string, Picked[]>
}
type Page = 'create' | 'script' | 'library' | 'settings'
const pageNames = {
  create: '创作台',
  library: '作品库',
  script: '剧本',
  settings: '设置',
}
const noJobs: JobView[] = []
function App() {
  const [notice, say] = useState('就绪'),
    [page, pageTo] = useState<Page>('create')
  const {state: data, refresh} = useStudioState(say)
  const jobs = data?.jobs ?? noJobs
  const [lastSubmitted, setLastSubmitted] = useState('')
  const [kind, setKind] = useState<MediaKind>('image'),
    [service, services] = useState({ image: '@site', video: '@site' }),
    [selectedModels, setSelectedModels] = useState<Record<string, string>>({}),
    [tpl, templateIds] = useState<Record<string, string>>({})
  const [prompts, setPrompts] = useState({ image: '', video: '' }),
    [drafts, setDrafts] = useState<Record<string, Draft>>({}),
    [shown, show] = useState(''),
    [chosen, choose] = useState('')
  const [editor, edit] = useState<{
      official: boolean
      profile?: ProfileView
    } | null>(null),
    [removing, remove] = useState<ProfileView | null>(null),
    [busy, markBusy] = useState(false)
  const [metadata, setMetadata] = useState<{
    id: string
    w: number
    h: number
    duration?: number
  }>()
  const [exporting, setExporting] = useState(false)
  const [unreadable, setUnreadable] = useState('')
  const [section, setSection] = useState<SettingsSection>('media')
  const [integrations, setIntegrations] = useState<Integrations>()
  const [openedScripts, setOpenedScripts] = useState(false)
  const [libraryView, setLibraryView] = useState(defaultLibraryView)
  const [shotBindings, setShotBindings] = useState<Partial<Record<MediaKind, ShotLink>>>({})
  const loadSettings = useCallback(async () => {
    try { setIntegrations(await window.studio.settings()) }
    catch (e) { say(msg(e)); throw e }
  }, [])
  useEffect(() => { void loadSettings().catch(() => {}) }, [loadSettings])
  function settingsPage(next: SettingsSection) {
    setSection(next)
    pageTo('settings')
  }
  function shotPrompt(destination: MediaKind, value: string, shot: ShotLink) {
    setShotBindings(prev => ({ ...prev, [destination]: shot }))
    const key = service[destination] + destination
    const t = siteTemplate(tpl[key] ?? '')
    if (t && !t.Text) templateIds(old => ({ ...old, [key]: defaultTemplate(destination).Key }))
    setKind(destination)
    setPrompts(old => ({ ...old, [destination]: value }))
    show('')
    pageTo('create')
    say('已填入分镜提示词，确认参数后即可生成。')
  }
  const lock = useRef(false)
  const official = data?.official
  const externals = (data?.profiles ?? []).filter(
    (p) => !isSite(p.ProtocolId) || p.BaseUrl !== siteBase,
  )
  const profile = externals.find(
    (p) => p.Id === service[kind] && mediaKind(p.ProtocolId) === kind,
  )
  const modelFor = (p: ProfileView) =>
    profileModels(p).includes(selectedModels[p.Id]) ? selectedModels[p.Id] : p.Model
  const selectedModel = profile && modelFor(profile)
  const id = profile?.Id ?? '@site',
    proto = profile?.ProtocolId ?? (kind === 'image' ? 'rh-image' : 'rh-video'),
    native = isSite(proto)
  const currentTemplate =
      siteTemplate(tpl[id + kind] ?? '') ?? defaultTemplate(kind),
    preset = presets[proto],
    controls = profile?.Controls,
    sizes =
      profile?.Relay?.sizes ??
      (controls?.sizes?.length ? controls.sizes : preset.sizes),
    seconds =
      profile?.Relay?.seconds ??
      (controls?.seconds?.length ? controls.seconds : preset.seconds),
    resolutions = controls?.resolutions?.length
      ? controls.resolutions
      : (preset.resolutions ?? []),
    modes = native
      ? [
          ...new Set(
            templates
              .filter((t) => t.Video === (kind === 'video'))
              .flatMap(officialModes),
          ),
        ]
      : [
          ...(preset.modes ?? []),
          ...Object.keys(profile?.Relay?.workflows ?? {}),
        ]
  const dk = JSON.stringify([
    id,
    kind,
    profile?.BaseUrl,
    native ? currentTemplate.Key : selectedModel,
  ])
  const draft: Draft = drafts[dk] ?? {
    config: native
      ? defaultConfig(currentTemplate)
      : {
          mode: modes[0],
          resolution: resolutions[0] ?? '',
          ratio: controls?.ratios?.[0] ?? '',
        },
    priority: 0,
    size: sizes[0],
    seconds: seconds[0] ?? 0,
    byMode: {},
  }
  const update = (patch: Partial<Draft>) =>
    setDrafts((old) => ({ ...old, [dk]: { ...(old[dk] ?? draft), ...patch } }))
  function updateConfig(patch: Record<string, Value>) {
    setDrafts(old => {
      const current = old[dk] ?? draft
      return { ...old, [dk]: { ...current, config: { ...current.config, ...patch } } }
    })
  }
  const mixedSite =
    native &&
    !currentTemplate.Video &&
    officialModes(currentTemplate).length > 1
  const mode = String(
    draft.config.mode ??
      (mixedSite ? (draft.intent ?? 't2i') : native ? 'default' : modes[0]),
  )
  const assets = draft.byMode[mode] ?? [],
    setAssets = (v: Picked[]) =>
      update({ byMode: { ...draft.byMode, [mode]: v } })
  const frameMode = mode === 'default' ? draft.intent : mode
  const firstFrame = kind === 'video' && (frameMode === 'first_frame' || frameMode === 'first_last') ? frameOrder(assets)[0] : undefined
  const previewFrame = firstFrame?.role === 'last_frame' ? undefined : firstFrame
  const [framePreview, setFramePreview] = useState<{ token: string; url: string }>()
  useEffect(() => {
    let active = true
    if (previewFrame) void window.studio.preview(previewFrame).then(path => {
      if (active && path) setFramePreview({ token: previewFrame.token, url: convertFileSrc(path) })
    }).catch(() => {})
    return () => { active = false }
  }, [previewFrame?.token])
  const frameUrl = previewFrame && framePreview?.token === previewFrame.token ? framePreview.url : ''
  const siteChoices = officialModes(currentTemplate)
  const intent = native
    ? siteChoices.includes(mode)
      ? mode
      : (draft.intent ??
        (siteChoices.includes('i2i') && assets.length ? 'i2i' : siteChoices[0]))
    : mode
  const fileSlots = native
    ? (mixedSite && intent === 't2i'
        ? []
        : slots(currentTemplate, draft.config)
      ).map((s) =>
        intent === 'i2i' && s.Kind === 'image'
          ? { ...s, Min: Math.max(1, s.Min) }
          : s,
      )
    : relaySlots(
        mode,
        preset.maxImages ?? 1,
        profile?.Relay?.workflows?.[mode]?.body,
      )
  const mappedBody =
    profile?.Relay?.workflows?.[mode]?.body ?? profile?.Relay?.body
  const uses = (...keys: string[]) =>
    !mappedBody || keys.some((k) => mappedBody.includes('{{' + k + '}}'))
  const showSize =
    uses('size', 'width', 'height') ||
    (!controls?.ratios?.length && uses('ratio'))
  const paired = mode === 'first_last'
  const fixedRatio =
    !native &&
    (proto === 'wan-i2v-video' ||
      proto === 'wan-frames-video' ||
      (proto === 'ark-video' && ['first_frame', 'first_last'].includes(mode)))
  function switchMode(next: string) {
    if (!native) {
      updateConfig({ mode: next })
      return
    }
    const t = siteChoices.includes(next)
      ? currentTemplate
      : templates.find(
          (t) =>
            t.Video === (kind === 'video') && officialModes(t).includes(next),
        )!
    const key = JSON.stringify([id, kind, profile?.BaseUrl, t.Key])
    const previous = drafts[key] ?? {
      config: defaultConfig(t),
      priority: 0,
      size: sizes[0],
      seconds: seconds[0] ?? 0,
      byMode: {},
    }
    const cfg = { ...previous.config }
    if ('mode' in cfg) cfg.mode = next
    templateIds((v) => ({ ...v, [id + kind]: t.Key }))
    setDrafts((v) => ({
      ...v,
      [key]: { ...previous, config: cfg, intent: next },
    }))
    show('')
  }
  const prompt = prompts[kind],
    text = (s: string) => setPrompts((p) => ({ ...p, [kind]: s })),
    hasPrompt = !native || !!currentTemplate.Text
  const needsKey = native && !(profile ?? official)?.hasKey,
    job = shown ? jobs.find((j) => j.id === shown) : undefined,
    recent = lastSubmitted ? jobs.find((j) => j.id === lastSubmitted) : undefined
  const attempt = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (e) {
      say(msg(e))
    }
  }
  function attach(slot: Slot, more: Picked[], role?: string) {
    setAssets(addAssets(assets, more, slot, paired, role))
  }
  const dropHandler = useRef<(paths: string[], x: number, y: number) => void>(
    () => {},
  )
  dropHandler.current = (paths, x, y) => {
    const hit = document.elementFromPoint(
      x / window.devicePixelRatio,
      y / window.devicePixelRatio,
    )
    const k = hit?.closest<HTMLElement>('[data-slot]')?.dataset.slot
    const role = hit?.closest<HTMLElement>('[data-role]')?.dataset.role
    const slot = fileSlots.find((s) => s.Kind === k)
    if (slot)
      void attempt(async () =>
        attach(slot, await window.studio.drop(slot.Kind, paths), role),
      )
  }
  useEffect(() => {
    const off = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === 'drop')
        dropHandler.current(
          payload.paths,
          payload.position.x,
          payload.position.y,
        )
    })
    return () => {
      void off.then((f) => f())
    }
  }, [])
  async function generate() {
    if (lock.current || !data) return
    if (needsKey) {
      edit({ official: id === '@site', profile: profile ?? official })
      return
    }
    if (hasPrompt && !prompt.trim()) {
      say('请先写下希望生成的内容。')
      document.querySelector<HTMLTextAreaElement>('#prompt')?.focus()
      return
    }
    for (const slot of fileSlots) {
      const n = assets.filter((a) => a.kind === slot.Kind).length
      if (n < slot.Min || n > slot.Max) {
        say(slot.Label + '需要 ' + slot.Min + '–' + slot.Max + ' 个素材。')
        return
      }
    }
    if (
      intent === 'reference' &&
      (!native || currentTemplate.AnyReference) &&
      !assets.length
    ) {
      say('请添加参考素材。')
      return
    }
    lock.current = true
    markBusy(true)
    try {
      const next = await window.studio.start({
        shot: shotBindings[kind],
        profileId: id,
        model: native ? undefined : selectedModel,
        kind,
        template: currentTemplate.Key,
        prompt: hasPrompt ? prompt : '',
        size: draft.size,
        seconds: draft.seconds,
        config: draft.config,
        priority: draft.priority,
        assets: paired ? frameOrder(assets) : assets,
      })
      setLastSubmitted(next)
      say('已加入后台，可以继续创作。')
      void refresh([next]).catch(e => say('任务已保存，读取进度时出错。' + msg(e)))
    } catch (e) {
      say(msg(e))
    } finally {
      lock.current = false
      markBusy(false)
    }
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key === 'Enter' &&
        !e.isComposing &&
        page === 'create' &&
        !document.querySelector('dialog[open]')
      ) {
        e.preventDefault()
        if (!e.repeat) void generate()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })
  function inspect(j: JobView, keepDraft = false) {
    setUnreadable('')
    show(j.id)
    choose(j.id)
    if (!keepDraft) setKind(j.kind)
    pageTo('create')
  }
  async function reuse(j: JobView) {
    const record = await window.studio.reuse(j.id)
    const sourceShot = j.shot ?? undefined
    const primary = isSite(j.protocol) && j.base === siteBase
    const p = primary
      ? undefined
      : externals.find(
          (p) =>
            p.Id === j.profileId &&
            p.BaseUrl === j.base &&
            p.ProtocolId === j.protocol,
        )
    if (!primary && !p)
      throw Error('原模型服务已移除或地址已修改，请先恢复连接。')
    const next = p?.Id ?? '@site',
      t = isSite(j.protocol) ? siteTemplate(j.model) : undefined,
      key = JSON.stringify([next, j.kind, p?.BaseUrl, j.model])
    if (p && !t && !profileModels(p).includes(j.model))
      throw Error(`请先将原模型 ${j.model} 加回此连接，再复用这条任务。`)
    const restoredIntent =
      t && !t.Video && officialModes(t).length > 1
        ? record.assets.length
          ? 'i2i'
          : 't2i'
        : undefined
    const conf = t
      ? { ...defaultConfig(t), ...j.site?.config }
      : {
          ...j.settings,
          mode:
            j.settings?.mode ??
            (j.legacyFrame
              ? 'first_frame'
              : (presets[j.protocol].modes?.[0] ?? 'default')),
        }
    if (t && !j.site) {
      if ('aspect' in conf) conf.aspect = j.size
      if ('ratio' in conf) conf.ratio = j.size
      if ('duration' in conf) conf.duration = j.seconds
    }
    setKind(j.kind)
    services((o) => ({ ...o, [j.kind]: next }))
    setShotBindings(o => ({ ...o, [j.kind]: sourceShot }))
    if (t) templateIds((o) => ({ ...o, [next + j.kind]: t.Key }))
    else if (p) setSelectedModels((o) => ({ ...o, [p.Id]: j.model }))
    setPrompts((o) => ({ ...o, [j.kind]: j.prompt }))
    setDrafts((o) => ({
      ...o,
      [key]: {
        config: conf,
        intent: restoredIntent,
        priority: j.site?.priority ?? 0,
        size: j.size,
        seconds: j.seconds,
        byMode: {
          [String(conf.mode ?? restoredIntent ?? 'default')]: record.assets,
        },
      },
    }))
    show('')
    pageTo('create')
    say('已恢复提示词、所选参数和素材顺序。')
  }
  async function continueWithImage(j: JobView, destination: MediaKind) {
    const wanted = destination === 'image' ? 'i2i' : 'first_frame'
    const candidates = externals.filter(p => mediaKind(p.ProtocolId) === destination)
    let p = candidates.find(p => p.Id === service[destination])
    function imageMode(connection?: ProfileView) {
      if (!connection || isSite(connection.ProtocolId)) return wanted
      const choices = [...(presets[connection.ProtocolId].modes ?? []), ...Object.keys(connection.Relay?.workflows ?? {})]
      if (choices.includes(wanted)) return wanted
      return destination === 'video' && choices.includes('first_last') ? 'first_last' : ''
    }
    const siteNeedsKey = (!p || isSite(p.ProtocolId)) && !(p ?? official)?.hasKey
    if (destination === 'video' && (!imageMode(p) || siteNeedsKey)) {
      p = candidates.find(c => c.hasKey && imageMode(c)) ??
        (official?.hasKey ? undefined : candidates.find(c => !isSite(c.ProtocolId) && imageMode(c)) ?? (imageMode(p) ? p : undefined))
    }
    const actual = imageMode(p), site = !p || isSite(p.ProtocolId), next = p?.Id ?? '@site'
    if (!actual)
      throw Error(
        '当前生成服务未配置带图方式，请在创作台为该媒体类型选择支持参考图的连接。',
      )
    const prev = siteTemplate(tpl[next + destination] ?? '')
    const t = site
      ? prev && officialModes(prev).includes(wanted)
        ? prev
        : wanted === 'first_frame'
          ? templates.find((t) => t.Key.startsWith('rh-sd20-mini-'))
          : templates.find((t) => officialModes(t).includes(wanted))
      : undefined
    const a = await window.studio.frame(j.id)
    const key = JSON.stringify([
      p?.Id ?? '@site',
      destination,
      p?.BaseUrl,
      t?.Key ?? (p && modelFor(p)),
    ])
    const old = drafts[key],
      cfg = t
        ? { ...defaultConfig(t), ...old?.config }
        : { resolution: p?.Controls?.resolutions?.[0] ?? (p && presets[p.ProtocolId].resolutions?.[0]) ?? '',
            ratio: p?.Controls?.ratios?.[0] ?? '', ...old?.config, mode: actual }
    if ('mode' in cfg) cfg.mode = actual
    const label = String(
        cfg.mode ??
          (t && !t.Video && officialModes(t).length > 1 ? actual : 'default'),
      ),
      size =
        p?.Relay?.sizes[0] ??
        p?.Controls?.sizes?.[0] ??
        (p ? presets[p.ProtocolId].sizes[0] : '')
    setKind(destination)
    services(o => ({ ...o, [destination]: next }))
    setShotBindings(o => ({ ...o, [destination]: j.shot ?? undefined }))
    if (t)
      templateIds((o) => ({ ...o, [(p?.Id ?? '@site') + destination]: t.Key }))
    setDrafts((o) => ({
      ...o,
      [key]: {
        ...old,
        config: cfg,
        priority: old?.priority ?? 0,
        intent: actual,
        size: old?.size ?? size,
        seconds:
          old?.seconds ??
          p?.Relay?.seconds[0] ??
          (p ? presets[p.ProtocolId].seconds[0] : 0) ??
          0,
        byMode: { ...old?.byMode, [label]: actual === 'first_last'
          ? [{ ...a, role: 'first_frame' }, ...frameOrder(old?.byMode[label] ?? []).filter(v => v.role === 'last_frame')] : [a] },
      },
    }))
    show('')
    pageTo('create')
    requestAnimationFrame(() => document.getElementById('prompt')?.focus({ preventScroll: true }))
    say(
      destination === 'image'
        ? '已设为图生图的参考图片。'
        : '已设为首帧，请确认视频参数。',
    )
  }
  async function saved(savedId: string) {
    const isOfficial = editor?.official
    const s = await refresh()
    if (!isOfficial) {
      const p = s.profiles.find((x) => x.Id === savedId)
      if (p) {
        const k = mediaKind(p.ProtocolId)
        setKind(k)
        services((o) => ({ ...o, [k]: p.Id }))
      }
    }
    edit(null)
    say('连接已保存。')
  }
  const customPixels = !!controls?.customSize && !fixedRatio
  const listedSize = sizes.includes(draft.size)
  const manualSize = customPixels && (draft.manualSize ?? !listedSize)
  const displaySize = (s: string) =>
    s === 'adaptive'
      ? '跟随首帧'
      : s === 'auto'
        ? '自动'
        : s.replace(/(\d+)x(\d+)/, '$1 × $2')
  const previewUrl =
    job?.file && job.mediaPath
      ? (job.mediaUrl ?? convertFileSrc(job.mediaPath))
      : ''
  const previewKey = job ? job.id + ':' + previewUrl : ''
  return (
    <div className="shell" data-performance={integrations?.performance ?? 'auto'}>
      <aside className="rail">
        <div className="brand">
          <span className="brand-mark">∞</span>
          <b>莫比环</b>
        </div>
        <nav aria-label="工作区">
          {(['create', 'script', 'library'] as const).map((k) => (
            <button
              key={k}
              className={page === k ? 'nav active' : 'nav'}
              aria-current={page === k ? 'page' : undefined}
              onClick={() => { if (k === 'script') setOpenedScripts(true); pageTo(k) }}
            >
              <Icon name={k} />
              {pageNames[k]}
            </button>
          ))}
        </nav>
        <button
          className={'nav rail-settings' + (page === 'settings' ? ' active' : '')}
          aria-current={page === 'settings' ? 'page' : undefined}
          onClick={() => pageTo('settings')}
        >
          <Icon name="settings" />
          设置
        </button>
      </aside>
      <main>
        <header className="top">
          <h1>{pageNames[page]}</h1>
          <div className="top-tools">
            <BackgroundTasks jobs={jobs} inspect={j => inspect(j, true)} />
            {page === 'create' && <div className="segments media-switch" aria-label="创作类型">
              {(['image', 'video'] as const).map(k =>
                <button key={k} aria-pressed={kind === k} onClick={() => { setKind(k); show('') }}>
                  {k === 'image' ? '图片' : '视频'}</button>)}
            </div>}
          </div>
        </header>
        {openedScripts && <ScriptDesk active={page === 'script'} writer={integrations?.writer}
          configure={() => settingsPage('writer')} usePrompt={shotPrompt} jobs={data?.jobs ?? []} inspect={inspect}
          useFrame={async (image, motion) => { await continueWithImage(image, 'video'); setPrompts(o => ({ ...o, video: motion })) }} />}
        {page === 'create' ? (
          <div className="work">
            <section className="canvas-col">
              <div className="canvas">
                {job ? (
                  previewUrl && unreadable !== previewKey ? (
                    job.kind === 'video' ? (
                      <video
                        key={job.id}
                        src={previewUrl}
                        onError={() => setUnreadable(previewKey)}
                        onLoadedMetadata={(e) => {
                          const v = e.currentTarget
                          setMetadata({
                            id: job.id,
                            w: v.videoWidth,
                            h: v.videoHeight,
                            duration: v.duration,
                          })
                        }}
                        controls
                        preload="metadata"
                      />
                    ) : (
                      <img
                        key={job.id}
                        src={previewUrl}
                        alt="作品预览"
                        onError={() => setUnreadable(previewKey)}
                        onLoad={(e) => {
                          const im = e.currentTarget
                          setMetadata({
                            id: job.id,
                            w: im.naturalWidth,
                            h: im.naturalHeight,
                          })
                        }}
                      />
                    )
                  ) : (
                    <JobPreviewState job={job} retry={previewUrl && unreadable === previewKey ? () => setUnreadable('') : undefined} />
                  )
                ) : (
                  <>
                    <img src={frameUrl || orbit} alt={frameUrl ? '视频首帧预览' : '折光回环示例'} />
                    <span className="badge">
                      {frameUrl ? '视频首帧' : kind === 'video' ? '镜头参考' : '图片示例'}
                    </span>
                    <div className="sample-caption">
                      <i />
                      {frameUrl ? previewFrame?.name : '折光回环'}
                    </div>
                  </>
                )}
              </div>
              <div className="detail panel">
                <div className="detail-heading">
                  <b>
                    {job
                      ? job.prompt || siteTemplate(job.model)?.Name || '作品'
                      : frameUrl ? '视频首帧已就绪' : kind === 'video'
                        ? '示例镜头提示词'
                        : '示例提示词'}
                  </b>
                  {job && <button className="link" onClick={() => {
                    show('')
                    document.getElementById('prompt')?.focus({ preventScroll: true })
                  }}>继续创作</button>}
                  {!job && !frameUrl && (
                    <button
                      className="link"
                      onClick={() => {
                        text(example[kind])
                        document.getElementById('prompt')?.focus()
                      }}
                    >
                      填入提示词 →
                    </button>
                  )}
                </div>
                <p>
                  {job
                    ? [
                        statusLabels[job.status],
                        siteTemplate(job.model)?.Name ?? job.profileName,
                        job.size,
                        job.seconds ? job.seconds + ' 秒' : '',
                        previewUrl && unreadable !== previewKey ? job.detail : '',
                        job.remoteId ? '任务 ' + job.remoteId : '',
                      ]
                        .filter(Boolean)
                        .join('　·　')
                    : frameUrl ? '填写镜头运动或画面变化，确认参数后即可生成视频。' : example[kind]}
                </p>
                {job && metadata?.id === job.id && (
                  <p className="media-info">
                    实际{job.kind === 'video' ? '视频' : '图片'} {metadata.w} ×{' '}
                    {metadata.h} · {aspect(metadata.w, metadata.h)}
                    {metadata.duration !== undefined &&
                    Number.isFinite(metadata.duration)
                      ? ' · ' + metadata.duration.toFixed(2) + ' 秒'
                      : ''}
                  </p>
                )}
                {job && (
                  <CloudSave job={job} settings={integrations} configure={() => settingsPage('storage')} report={say} />
                )}
                {job && (
                  <div className="inline-actions">
                    {job.file && (
                      <button
                        onClick={() =>
                          void attempt(async () => {
                            const f = await window.studio.exportFile(
                              job.id,
                              null,
                              true,
                            )
                            if (f) say('原文件已另存到 ' + f)
                          })
                        }
                      >
                        另存原文件
                      </button>
                    )}
                    {job.kind === 'image' && metadata?.id === job.id && (
                      <button onClick={() => setExporting(true)}>
                        按尺寸导出
                      </button>
                    )}
                    {job.file && (
                      <button
                        onClick={() =>
                          void attempt(() => window.studio.open(job.id))
                        }
                      >
                        打开原文件
                      </button>
                    )}
                    <button onClick={() => void attempt(() => reuse(job))}>
                      复用参数
                    </button>
                    {job.file && job.kind === 'image' && (
                      <>
                        <button
                          onClick={() =>
                            void attempt(() => continueWithImage(job, 'image'))
                          }
                        >
                          用作图生图参考
                        </button>
                        <button
                          onClick={() =>
                            void attempt(() => continueWithImage(job, 'video'))
                          }
                        >
                          作为视频首帧
                        </button>
                      </>
                    )}
                    {job.status === 'paused' && (
                      <button
                        onClick={() =>
                          void attempt(() => window.studio.resume(job.id))
                        }
                      >
                        恢复任务
                      </button>
                    )}
                  </div>
                )}
              </div>
            </section>
            <aside className="settings panel">
              <div className="settings-scroll">
                <h2>生成设置</h2>
                <label>生成服务</label>
                <div className="service-row">
                  <select
                    aria-label="生成服务"
                    value={id}
                    onChange={(e) => {
                      services((o) => ({ ...o, [kind]: e.target.value }))
                      show('')
                    }}
                  >
                    <option value="@site">AIGC 创作空间 · 官网</option>
                    {externals
                      .filter((p) => mediaKind(p.ProtocolId) === kind)
                      .map((p) => (
                        <option key={p.Id} value={p.Id}>
                          {p.Name}
                        </option>
                      ))}
                  </select>
                  <button
                    title="管理模型连接"
                    aria-label="管理模型连接"
                    onClick={() => settingsPage('media')}
                  >
                    <Icon name="settings" />
                  </button>
                </div>
                <label>
                  创作方式
                  <select
                    aria-label="创作方式"
                    value={intent}
                    onChange={(e) => switchMode(e.target.value)}
                  >
                    {modes.map((m) => (
                      <option key={m} value={m}>
                        {modeLabels[m] ?? m}
                      </option>
                    ))}
                  </select>
                </label>
                {native ? (
                  <label>
                    官网模板
                    <select
                      value={currentTemplate.Key}
                      onChange={(e) => {
                        templateIds((o) => ({
                          ...o,
                          [id + kind]: e.target.value,
                        }))
                        show('')
                      }}
                    >
                      {templates
                        .filter((t) => t.Video === (kind === 'video'))
                        .map((t) => (
                          <option key={t.Key} value={t.Key}>
                            {t.Name}
                          </option>
                        ))}
                    </select>
                  </label>
                ) : profile && profileModels(profile).length > 1 ? (
                  <label>
                    生成模型
                    <select aria-label="生成模型" value={selectedModel} onChange={(e) => {
                      const value = e.target.value
                      setSelectedModels((old) => ({ ...old, [id]: value }))
                      show('')
                    }}>
                      {profileModels(profile).map((model) => (
                        <option key={model}>{model}</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <small>
                    {selectedModel} · {preset.title}
                  </small>
                )}
                {shotBindings[kind] && <div className="bound-shot"><span>{shotBindings[kind]!.label}</span>
                  <button className="link" onClick={() => setShotBindings(o => ({ ...o, [kind]: undefined }))}>解除关联</button></div>}
                {hasPrompt && (
                  <Prompt
                    value={prompt}
                    change={text}
                    hint={
                      (native && currentTemplate.Text?.Hint) ||
                      (kind === 'video'
                        ? '描述场景、动作和镜头运动…'
                        : '描述主体、光线和画面构图…')
                    }
                  />
                )}
                <div className="two options">
                  {native ? (
                    currentTemplate.Fields.filter(
                      (f) =>
                        f.Key !== 'mode' &&
                        f.Type !== 'boolean' &&
                        f.Options?.length !== 1,
                    ).map((f) => (
                      <label
                        key={f.Key}
                        className={f.Key === 'mode' ? 'span' : ''}
                      >
                        {f.Label}
                        <select
                          value={String(draft.config[f.Key])}
                          onChange={(e) =>
                            updateConfig({ [f.Key]: f.Type === 'number' ? Number(e.target.value) : e.target.value })
                          }
                        >
                          {f.Type === 'number'
                            ? Array.from(
                                {
                                  length:
                                    Math.floor((f.Max! - f.Min!) / f.Step!) + 1,
                                },
                                (_, i) => f.Min! + i * f.Step!,
                              ).map((n) => <option key={n}>{n}</option>)
                            : f.Options?.map((o) => (
                                <option value={o.Value} key={o.Value}>
                                  {o.Label}
                                </option>
                              ))}
                        </select>
                      </label>
                    ))
                  ) : (
                    <>
                      {showSize &&
                        (fixedRatio ? (
                          <label>
                            画幅
                            <input value="跟随首帧" readOnly />
                          </label>
                        ) : (
                          <label>
                            {sizes.some((s) => s.includes('x'))
                              ? '输出尺寸'
                              : '画幅'}
                            <select
                              aria-label="输出尺寸或画幅"
                              value={manualSize ? 'custom' : draft.size}
                              onChange={(e) =>
                                update({
                                  size:
                                    e.target.value === 'custom'
                                      ? '1280x1280'
                                      : e.target.value,
                                })
                              }
                            >
                              {sizes.map((s) => (
                                <option key={s} value={s}>
                                  {displaySize(s)}
                                </option>
                              ))}
                              {customPixels && (
                                <option value="custom">自定义像素</option>
                              )}
                            </select>
                          </label>
                        ))}
                      {showSize && manualSize && (
                        <label>
                          宽 × 高（像素）
                          <input
                            aria-label="自定义像素尺寸"
                            value={draft.size}
                            onChange={(e) =>
                              update({
                                size: e.target.value.replace(/[×*]/g, 'x'),
                              })
                            }
                            placeholder="例如 1344x768"
                          />
                        </label>
                      )}
                      {!native &&
                        uses('ratio') &&
                        !!controls?.ratios?.length && (
                          <label>
                            输出画幅
                            <select
                              aria-label="输出画幅"
                              value={String(
                                draft.config.ratio ?? controls.ratios[0],
                              )}
                              onChange={(e) =>
                                updateConfig({ ratio: e.target.value })
                              }
                            >
                              {controls.ratios.map((r) => (
                                <option key={r}>{r}</option>
                              ))}
                            </select>
                          </label>
                        )}
                      {uses('resolution') && !!resolutions.length && (
                        <label>
                          分辨率
                          <select
                            aria-label="分辨率"
                            value={String(
                              draft.config.resolution ?? resolutions[0],
                            )}
                            onChange={(e) =>
                              updateConfig({ resolution: e.target.value })
                            }
                          >
                            {resolutions.map((r) => (
                              <option key={r}>{r}</option>
                            ))}
                          </select>
                        </label>
                      )}
                      {proto === 'openai-image' && (
                        <label>
                          图片质量
                          <select
                            aria-label="图片质量"
                            value={String(draft.config.quality ?? '')}
                            onChange={(e) =>
                              updateConfig({ quality: e.target.value })
                            }
                          >
                            <option value="">模型默认</option>
                            <option value="low">低</option>
                            <option value="medium">中</option>
                            <option value="high">高</option>
                          </select>
                        </label>
                      )}
                      {kind === 'video' && uses('seconds') && (
                        <label>
                          时长（秒）
                          <select
                            aria-label="时长（秒）"
                            value={draft.seconds}
                            onChange={(e) =>
                              update({ seconds: +e.target.value })
                            }
                          >
                            {seconds.map((s) => (
                              <option key={s}>{s}</option>
                            ))}
                          </select>
                        </label>
                      )}
                    </>
                  )}
                </div>
                {native && (
                  <div className="toggles">
                    {currentTemplate.Fields.filter(
                      (f) => f.Type === 'boolean',
                    ).map((f) => (
                      <label key={f.Key}>
                        <input
                          type="checkbox"
                          checked={draft.config[f.Key] === true}
                          onChange={(e) =>
                            updateConfig({ [f.Key]: e.target.checked })
                          }
                        />
                        {f.Label}
                      </label>
                    ))}
                  </div>
                )}
                {!native &&
                  profile?.Relay?.parameters
                    ?.filter((p) =>
                      (
                        profile.Relay?.workflows?.[mode]?.body ??
                        profile.Relay?.body ??
                        ''
                      ).includes('{{params.' + p.key + '}}'),
                    )
                    .map((p) => (
                      <ParameterField
                        key={p.key}
                        spec={p}
                        value={draft.config['params.' + p.key] ?? p.default}
                        change={(v) =>
                          updateConfig({ ['params.' + p.key]: v })
                        }
                      />
                    ))}
                {fileSlots.map((slot) => (
                  <Assets
                    key={dk + mode + slot.Kind}
                    slot={slot}
                    items={assets}
                    paired={paired}
                    allowLink={proto !== 'openai-video' && proto !== 'comfy-image'}
                    jobs={data?.jobs ?? []}
                    performance={integrations?.performance ?? 'auto'}
                    add={(v, role) => attach(slot, v, role)}
                    change={setAssets}
                    report={say}
                  />
                ))}
                {proto === 'comfy-image' && <ComfyControls config={draft.config} imageInput={mode === 'i2i'}
                  change={updateConfig} />}
                {native && currentTemplate.Hint && (
                  <p className="help">{currentTemplate.Hint}</p>
                )}
                {native &&
                  currentTemplate.Rate !== currentTemplate.FastRate && (
                    <label>
                      任务队列
                      <select
                        value={draft.priority}
                        onChange={(e) => update({ priority: +e.target.value })}
                      >
                        <option value="0">普通队列</option>
                        <option value="1">高优先级队列</option>
                      </select>
                    </label>
                  )}
              </div>
              <div className="generate-foot">
                {recent && <div className="latest-task" role="group" aria-label="最近提交的任务">
                  <div aria-live="polite" aria-atomic="true">
                    <small>最近提交 · {statusLabels[recent.status] || recent.status}</small>
                    <span title={recent.prompt}>{recent.prompt || siteTemplate(recent.model)?.Name || recent.model}</span>
                  </div>
                  <button className="link" onClick={() => inspect(recent, true)}>{jobAction(recent)}</button>
                </div>}
                <small>
                  {native
                    ? quote(currentTemplate, draft.config, draft.priority)
                    : proto === 'comfy-image' ? '由所连 ComfyUI 运行'
                    : '由所选服务商结算'}
                </small>
                <button
                  className="primary generate"
                  disabled={busy || !data}
                  onClick={e => { if (e.detail <= 1) void generate() }}
                >
                  {busy
                    ? '正在添加任务…'
                    : needsKey
                      ? '连接官网 Key'
                      : native && !hasPrompt
                        ? '处理视频'
                        : kind === 'video'
                          ? '生成视频'
                          : '生成图片'}
                </button>
              </div>
            </aside>
          </div>
        ) : page === 'library' ? (
          <WorkLibrary jobs={data?.jobs ?? []} view={libraryView} setView={setLibraryView}
            selectedId={chosen} select={choose} inspect={inspect} makeVideo={j => continueWithImage(j, 'video')}
            settings={integrations} configureStorage={() => settingsPage('storage')} report={say} attempt={attempt}/>
        ) : page === 'settings' ? (
          <Settings section={section} select={setSection} integrations={integrations} reload={loadSettings}
            profiles={externals} official={official} edit={(official, profile) => edit({ official, profile })}
            remove={remove} keyStorage={data?.keyStorage ?? ''}
            folder={() => void attempt(() => window.studio.folder())}
            website={() => void attempt(async () => {
              await window.studio.web(prompt)
              say(prompt ? '提示词已复制，已打开官网工作台。' : '已打开官网工作台。')
            })} />
        ) : null}
        <footer className="status">
          <span role="status" title={notice}>
            {notice}
          </span>
          {page === 'create' && <small>Ctrl / ⌘ + Enter　生成</small>}
        </footer>
      </main>
      {exporting && job && metadata?.id === job.id && (
        <ImageExport
          job={job}
          url={previewUrl}
          w={metadata.w}
          h={metadata.h}
          close={() => setExporting(false)}
          saved={(path, engine, reason) => say(`${engine} 已导出到 ${path}${reason ? '（GPU 回退原因 ' + reason + '）' : ''}`)}
        />
      )}
      {editor && (
        <ConnectionEditor
          {...editor}
          kind={kind}
          storage={data?.keyStorage ?? ''}
          close={() => edit(null)}
          saved={saved}
        />
      )}
      {removing && (
        <Modal title="移除模型服务" close={() => remove(null)}>
          <p>移除「{removing.Name}」的连接？作品仍可在作品库打开。</p>
          <footer className="modal-actions">
            <button onClick={() => remove(null)}>取消</button>
            <button
              onClick={() =>
                void attempt(async () => {
                  await window.studio.remove(removing.Id)
                  remove(null)
                  await refresh()
                })
              }
            >
              移除连接
            </button>
          </footer>
        </Modal>
      )}
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
