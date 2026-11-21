import rawTemplates from '../src/RhTemplates.json'
import generationPresets from '../src/GenerationPresets.json'

export type Kind = 'image' | 'video' | 'audio'
export type MediaKind = 'image' | 'video'
export type Value = string | number | boolean
export type Protocol =
  | 'rh-image'
  | 'rh-video'
  | 'openai-image'
  | 'openai-video'
  | 'wan-image'
  | 'wan-video'
  | 'wan-i2v-video'
  | 'wan-frames-video'
  | 'ark-video'
  | 'relay-image'
  | 'relay-video'
export interface Slot {
  Kind: Kind
  Label: string
  Min: number
  Max: number
}
export interface Field {
  Key: string
  Label: string
  Type: string
  Default: Value
  Min?: number
  Max?: number
  Step?: number
  Options?: { Value: string; Label: string; Factor: number }[]
}
export interface Template {
  Key: string
  Name: string
  Video: boolean
  Hint: string
  PerSecond: boolean
  Rate: number
  FastRate: number
  AnyReference: boolean
  Text: { Required: boolean; Hint: string } | null
  Fields: Field[]
  Slots: Slot[]
}
export const templates = rawTemplates as Template[]
export const siteBase = 'https://queueapi.vylai.com/openapi'
export const workbench = 'https://rh.vylai.com/workbench'
export const isSite = (p: Protocol) => p === 'rh-image' || p === 'rh-video'
export const isCustom = (p: Protocol) =>
  p === 'relay-image' || p === 'relay-video'
export const mediaKind = (p: Protocol): MediaKind =>
  p.endsWith('-video') ? 'video' : 'image'
export const siteTemplate = (key: string) =>
  templates.find((t) => t.Key === key)
export const defaultTemplate = (kind: MediaKind) =>
  templates.find((t) => t.Video === (kind === 'video'))!
export interface Preset {
  modes?: string[]
  resolutions?: string[]
  maxImages?: number
  title: string
  base: string
  model: string
  sizes: string[]
  seconds: number[]
}
const landscape = ['16:9', '9:16', '1:1'],
  pixels = ['1024x1024', '1536x1024', '1024x1536']
export const presets: Record<Protocol, Preset> = {
  'rh-image': {
    title: '官网图片模板',
    base: siteBase,
    model: defaultTemplate('image').Key,
    sizes: landscape,
    seconds: [],
  },
  'rh-video': {
    title: '官网视频模板',
    base: siteBase,
    model: defaultTemplate('video').Key,
    sizes: landscape,
    seconds: [5, 10, 15],
  },
  ...generationPresets,
}
export interface Controls {
  sizes: string[]
  seconds: number[]
  resolutions: string[]
  ratios: string[]
  customSize: boolean
}
export interface Workflow {
  submit: string
  body: string
  encoding: 'json' | 'multipart'
}
export const modeLabels: Record<string, string> = {
  t2i: '文生图',
  i2i: '图生图',
  t2v: '文生视频',
  first_frame: '图生视频 · 首帧',
  first_last: '首尾帧视频',
  reference: '多素材参考视频',
  process: '视频处理',
}
export function officialModes(t: Template): string[] {
  if (!t.Video)
    return t.Slots.length
      ? t.Slots.some((s) => s.Min > 0)
        ? ['i2i']
        : ['t2i', 'i2i']
      : ['t2i']
  if (!t.Text) return ['process']
  return (
    t.Fields.find((f) => f.Key === 'mode')?.Options?.map((o) => o.Value) ?? [
      'reference',
    ]
  )
}
export function relaySlots(mode: string, max: number, body?: string): Slot[] {
  if (mode === 't2i' || mode === 't2v') return []
  if (mode === 'first_frame' || mode === 'first_last') {
    const n = mode === 'first_last' ? 2 : 1
    return [
      {
        Kind: 'image',
        Label: n === 2 ? '首帧与尾帧' : '首帧图片',
        Min: n,
        Max: n,
      },
    ]
  }
  if (mode === 'i2i')
    return [
      {
        Kind: 'image',
        Label: '参考图片',
        Min: 1,
        Max: body && !body.includes('{{images') ? 1 : max,
      },
    ]
  const possible: Slot[] = [
    { Kind: 'image', Label: '参考图片', Min: 0, Max: max },
    { Kind: 'video', Label: '参考视频', Min: 0, Max: 3 },
    { Kind: 'audio', Label: '参考音频', Min: 0, Max: 3 },
  ]
  return possible.filter((s) => !body || body.includes('{{' + s.Kind + 's'))
}
export function defaultWorkflow(mode: string): Workflow {
  const image = mode === 'i2i'
  return {
    submit: image ? 'images/edits' : 'video/generations',
    encoding: 'json',
    body: JSON.stringify(
      {
        model: '{{model}}',
        prompt: '{{prompt}}',
        size: '{{size}}',
        ...(image ? {} : { duration: '{{seconds}}' }),
        ...(image
          ? { images: '{{images}}' }
          : mode === 'first_frame'
            ? { first_frame: '{{first_frame}}' }
            : mode === 'first_last'
              ? { first_frame: '{{first_frame}}', last_frame: '{{last_frame}}' }
              : {
                  images: '{{images}}',
                  videos: '{{videos}}',
                  audios: '{{audios}}',
                }),
      },
      null,
      2,
    ),
  }
}
export const emptyControls = (): Controls => ({
  sizes: [],
  seconds: [],
  ratios: [],
  resolutions: [],
  customSize: false,
})
export interface Parameter {
  key: string
  label: string
  type: 'text' | 'number' | 'select' | 'boolean'
  default: Value
  choices?: string[]
  min?: number
  max?: number
}
export interface RelayMap {
  parameters?: Parameter[]
  encoding?: 'json' | 'multipart'
  workflows?: Record<string, Workflow>
  auth:
    | 'bearer'
    | 'x-api-key'
    | 'x-auth-token'
    | 'api-key'
    | 'x-goog-api-key'
    | 'token'
    | 'none'
  submit: string
  poll: string
  body: string
  id: string
  state: string
  url: string
  base64: string
  error: string
  success: string
  failure: string
  waiting: string
  sizes: string[]
  seconds: number[]
}
export function defaultRelay(kind: MediaKind): RelayMap {
  const video = kind === 'video'
  return {
    auth: 'bearer',
    submit: video ? 'video/generations' : 'images/generations',
    poll: video ? 'tasks/{id}' : '',
    body: JSON.stringify(
      video
        ? {
            model: '{{model}}',
            prompt: '{{prompt}}',
            size: '{{size}}',
            duration: '{{seconds}}',
          }
        : { model: '{{model}}', prompt: '{{prompt}}', size: '{{size}}' },
      null,
      2,
    ),
    id: 'data.id',
    state: 'data.status',
    url: video ? 'data.url' : 'data.0.url',
    base64: video ? '' : 'data.0.b64_json',
    error: 'error.message',
    success: 'completed,succeeded,success',
    failure: 'failed,canceled,cancelled,expired',
    waiting: 'queued,pending,processing,running,in_progress',
    sizes: video ? [...landscape] : [...pixels],
    seconds: video ? [5, 10, 15] : [],
  }
}
export interface Asset {
  Kind: Kind
  Name: string
  Path: string
}
export interface Picked {
  role?: string
  kind: Kind
  name: string
  token: string
}
export interface SiteOptions {
  Config: Record<string, Value>
  Priority: number
  Assets: Asset[]
}
export interface Profile {
  Id: string
  Name: string
  ProtocolId: Protocol
  BaseUrl: string
  Model: string
  Models?: string[]
  Relay?: RelayMap
  Controls?: Controls
  Keys?: Record<string, string>
  Secrets?: Record<string, string>
}
export type ProfileView = Omit<Profile, 'Keys' | 'Secrets'> & {
  hasKey: boolean
}
export const profileModels = (p: ProfileView) => [p.Model, ...(p.Models ?? [])]
export interface EditProfile {
  models?: string[]
  sessionOnly?: boolean
  controls?: Controls
  id?: string
  name: string
  protocol: Protocol
  base: string
  model: string
  key: string
  relay?: RelayMap
}
export interface ModelLookup {
  source: 'writer' | 'connection'
  base: string
  key: string
  id?: string
  auth?: RelayMap['auth']
}
export interface ModelCatalog {
  base: string
  models: string[]
}
export interface Job {
  Id: string
  ProfileId: string
  ProfileName: string
  ProtocolId: Protocol
  BaseUrl: string
  Model: string
  Prompt: string
  Size: string
  Seconds: number
  Reference?: string | null
  SiteOptions?: SiteOptions | null
  Relay?: RelayMap
  Status: string
  Detail: string
  RemoteId?: string | null
  ResultUrl?: string | null
  FileName?: string | null
  CreatedUtc: string
}
export interface JobView {
  cloud?: { status: 'pending' | 'uploading' | 'saved' | 'failed'; uri: string; endpoint: string; detail: string } | null
  mediaUrl?: string
  settings?: Record<string, Value>
  legacyFrame?: boolean
  id: string
  profileId: string
  profileName: string
  protocol: Protocol
  base: string
  model: string
  prompt: string
  size: string
  seconds: number
  kind: MediaKind
  status: string
  detail: string
  remoteId: string
  created: number
  file: boolean
  mediaPath?: string
  site?: { config: Record<string, Value>; priority: number }
}
export interface Start {
  profileId: string
  model?: string
  kind: MediaKind
  template: string
  prompt: string
  size: string
  seconds: number
  config: Record<string, Value>
  priority: number
  assets: Picked[]
}
export interface State {
  profiles: ProfileView[]
  official: ProfileView
  jobs: JobView[]
  keyStorage: string
}
export interface Reuse {
  job: JobView
  assets: Picked[]
}
export interface StorageTarget {
  endpoint: string
  bucket: string
  region: string
  prefix: string
  accessKey: string
  virtualHost: boolean
  automatic: boolean
}
export interface Integrations {
  writer: { base: string; model: string; hasKey: boolean }
  storage: StorageTarget
  hasStorageKey: boolean
}
export interface Scene {
  heading: string
  action: string
  dialogue: string
  imagePrompt: string
  videoPrompt: string
}
export interface Screenplay {
  title: string
  scenes: Scene[]
}
export interface Script extends Screenplay {
  id: string
  created: number
  brief: string
  model: string
}
export const defaultConfig = (t: Template): Record<string, Value> =>
  Object.fromEntries(t.Fields.map((f) => [f.Key, f.Default]))
export function slots(t: Template, config: Record<string, Value>): Slot[] {
  if (config.mode === 't2v') return []
  if (config.mode === 'first_frame' || config.mode === 'first_last') {
    const n = config.mode === 'first_last' ? 2 : 1
    return [
      {
        Kind: 'image',
        Label: n === 1 ? '首帧图片' : '首帧与尾帧（按顺序）',
        Min: n,
        Max: n,
      },
    ]
  }
  return t.Slots
}
export function quote(
  t: Template,
  config: Record<string, Value>,
  priority: number,
) {
  let rate = priority ? t.FastRate : t.Rate
  for (const f of t.Fields)
    rate *= f.Options?.find((o) => o.Value === config[f.Key])?.Factor ?? 1
  const inputSeconds = t.PerSecond && !config.duration
  const price =
    rate * (t.PerSecond && !inputSeconds ? Number(config.duration) : 1)
  return (
    (inputSeconds ? '按输入视频时长　¥' : '预计　¥') +
    price.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
      useGrouping: false,
    }) +
    (inputSeconds ? ' / 秒' : '')
  )
}
export const statusLabels: Record<string, string> = {
  preparing: '准备素材',
  submitting: '提交中',
  waiting: '生成中',
  downloading: '保存中',
  done: '已完成',
  paused: '待恢复',
  uncertain: '提交待核实',
  failed: '失败',
}
export interface Bridge {
  settings(): Promise<Integrations>
  saveWriter(input: { base: string; model: string; key: string }): Promise<void>
  saveStorage(target: StorageTarget, secret: string): Promise<void>
  uploadImage(id: string): Promise<void>
  scripts(): Promise<Script[]>
  generateScript(brief: string, count: number): Promise<Script>
  editScript(id: string, story: Screenplay): Promise<Script>
  exportFile(
    id: string,
    resize: { width: number; height: number; fit: 'crop' | 'contain' } | null,
    chooseLocation: boolean,
  ): Promise<string | null>
  link(kind: Kind, url: string): Promise<Picked>
  preview(item: Picked): Promise<string | null>
  state(): Promise<State>
  save(input: EditProfile): Promise<string>
  remove(id: string): Promise<void>
  models(input: EditProfile): Promise<string[]>
  discoverModels(input: ModelLookup): Promise<ModelCatalog>
  pick(kind: Kind, multiple: boolean): Promise<Picked[]>
  drop(kind: Kind, paths: string[]): Promise<Picked[]>
  frame(id: string): Promise<Picked>
  start(input: Start): Promise<string>
  resume(id: string): Promise<void>
  reuse(id: string): Promise<Reuse>
  open(id: string): Promise<void>
  folder(): Promise<void>
  web(prompt: string): Promise<void>
  changed(cb: () => void): () => void
}
declare global {
  interface Window {
    studio: Bridge
  }
}
