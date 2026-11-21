import { useEffect, useState, type FormEvent } from 'react'
import { presets, profileModels, type Integrations, type ProfileView, type StorageTarget } from '../shared'
import { ModelPicker, useModelCatalog } from './ModelPicker'
import storageProviders from '../../src/StorageProviders.json'
import { MediaToolSettings } from './MediaToolSettings'
import { PerformanceSettings } from './PerformanceSettings'

const sections = { media: '图片与视频', writer: '剧本模型', storage: '对象存储', performance: '性能', files: '文件与工具' }
export type SettingsSection = keyof typeof sections

interface Props {
  section: SettingsSection
  select: (section: SettingsSection) => void
  integrations?: Integrations
  reload: () => Promise<void>
  profiles: ProfileView[]
  official?: ProfileView
  edit: (official: boolean, profile?: ProfileView) => void
  remove: (profile: ProfileView) => void
  keyStorage: string
  website: () => void
  folder: () => void
}

export function Settings(props: Props) {
  const { section, integrations, official } = props
  return <section className="preferences page-body" aria-label="应用设置">
    <nav className="settings-menu" aria-label="设置分类">
      {(Object.keys(sections) as SettingsSection[]).map(k =>
        <button key={k} aria-current={section === k ? 'page' : undefined} onClick={() => props.select(k)}>{sections[k]}</button>)}
    </nav>
    <div className="preferences-content" key={section}>
      <h2>{sections[section]}</h2>
      {section === 'media' && <>
        <div className="preference-row"><div><h3>AIGC 创作空间 · 官网</h3>
          <p>图片与视频共用官网 Key · {official?.hasKey ? '已配置' : '待配置'}</p></div>
          <button onClick={() => props.edit(true, official)}>配置官网 Key</button></div>
        <div className="preference-row"><div><h3>模型厂商与中转站</h3><p>为图片或视频添加独立的服务与模型。</p></div>
          <button onClick={() => props.edit(false)}>添加模型服务</button></div>
        {props.profiles.map(p => <div key={p.Id} className="preference-row saved-profile">
          <div><b>{p.Name}</b><p>{presets[p.ProtocolId]?.title} · {p.Model}{!!p.Models?.length && ` 等 ${profileModels(p).length} 个模型`}</p><small>{p.BaseUrl}</small></div>
          <button aria-label={`编辑 ${p.Name}`} onClick={() => props.edit(false, p)}>编辑</button>
          <button aria-label={`移除 ${p.Name}`} onClick={() => props.remove(p)}>移除</button></div>)}
      </>}
      {section === 'writer' && integrations && <WriterForm data={integrations.writer} reload={props.reload} />}
      {section === 'storage' && integrations && <StorageForm data={integrations} reload={props.reload} />}
      {section === 'performance' && integrations && <PerformanceSettings mode={integrations.performance} reload={props.reload} />}
      {(section === 'writer' || section === 'storage' || section === 'performance') && !integrations &&
        <button onClick={() => void props.reload().catch(() => {})}>重新读取设置</button>}
      {section === 'files' && <><MediaToolSettings/>
        <div className="preference-row"><div><h3>本地作品</h3><p>查看已保存的原图、视频和导出副本。</p></div>
          <button onClick={props.folder}>打开作品目录</button></div>
        <div className="preference-row"><div><h3>网站工作台</h3><p>复制创作台的当前提示词，并打开官网。</p></div>
          <button onClick={props.website}>网站工作台 ↗</button></div>
      </>}
      {section !== 'files' && section !== 'performance' && <p className="vault-note">{props.keyStorage}</p>}
    </div>
  </section>
}

function useSave(reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(''), [failed, setFailed] = useState(false)
  async function submit(e: FormEvent, write: () => Promise<void>) {
    e.preventDefault()
    if (busy) return
    setBusy(true); setMessage(''); setFailed(false)
    try {
      await write()
      await reload()
      setMessage('设置已保存。')
    } catch (error) {
      setMessage(String(error)); setFailed(true)
    } finally { setBusy(false) }
  }
  return { submit, busy, clearFeedback: () => setMessage(''), feedback: <span role="status" className={failed ? 'error' : 'help'}>{message}</span> }
}

function WriterForm({ data, reload }: { data: Integrations['writer']; reload: Props['reload'] }) {
  const [base, setBase] = useState(data.base), [model, setModel] = useState(data.model), [key, setKey] = useState('')
  const catalog = useModelCatalog({ source: 'writer', base, key })
  const { submit, busy, feedback } = useSave(reload)
  return <form className="integration-form" onSubmit={e => void submit(e, async () => {
    const apiBase = catalog.baseForSave(data.hasKey ? data.base : undefined, true)
    await window.studio.saveWriter({ base: apiBase, model, key })
    setBase(apiBase.trim().replace(/\/+$/, ''))
    setKey('')
  })}>
    <p>剧本和提示词优化共用这条文本模型连接。支持 Chat Completions 兼容服务，生成剧本还需要模型支持 JSON 输出。</p>
    <label>剧本服务地址<input type="url" required disabled={busy} value={base} onChange={e => { setBase(e.target.value); setKey('') }} /></label>
    <label>剧本 API Key<input type="password" autoComplete="new-password" disabled={busy} value={key} onChange={e => setKey(e.target.value)}
      placeholder={data.hasKey && base.trim().replace(/\/+$/, '') === data.base ? '已保存，留空沿用' : '输入这个服务的 API Key'} /></label>
    <ModelPicker label="剧本模型 ID" value={model} change={setModel} catalog={catalog}
      canFetch={!!base.trim()} disabled={busy} hints={base.trim().replace(/\/+$/, '') === 'https://api.deepseek.com' ? ['deepseek-v4-pro', 'deepseek-flash'] : undefined} />
    <div className="form-end"><button className="primary" disabled={busy || catalog.loading}>保存剧本模型</button>{feedback}</div>
  </form>
}

function StorageForm({ data, reload }: { data: Integrations; reload: Props['reload'] }) {
  const [target, setTarget] = useState(data.storage), [secret, setSecret] = useState('')
  const { submit, busy, feedback, clearFeedback } = useSave(reload)
  useEffect(() => { setTarget(data.storage) }, [data.storage])
  const preset = storageProviders.find(p => p.id === target.provider)!
  const generic = target.provider === 's3', cos = target.provider === 'tencent'
  const region = target.region.trim()
  const template = region.startsWith('cn-') && preset.chinaEndpoint ? preset.chinaEndpoint : preset.endpoint
  const endpoint = generic ? target.endpoint : target.customDomain || template.replace('{region}', region)
  const savedKey = data.hasStorageKey && target.provider === data.storage.provider &&
    endpoint.trim().replace(/\/+$/, '') === data.storage.endpoint && target.accessKey.trim() === data.storage.accessKey
  function update<K extends keyof StorageTarget>(k: K, value: StorageTarget[K]) {
    clearFeedback()
    setTarget(old => ({ ...old, [k]: value }))
    if (['region', 'endpoint', 'customDomain', 'accessKey'].includes(k)) setSecret('')
  }
  function selectProvider(provider: StorageTarget['provider']) {
    clearFeedback()
    setSecret('')
    if (provider === data.storage.provider) { setTarget(data.storage); return }
    const next = storageProviders.find(p => p.id === provider)!
    setTarget({ provider, region: next.regions[0], endpoint: '', customDomain: '', bucket: '', accessKey: '',
      prefix: target.prefix, virtualHost: provider !== 's3', automatic: false })
  }
  return <form className="integration-form" onSubmit={e => void submit(e, async () => {
    await window.studio.saveStorage(target, secret); setSecret('')
  })}>
    <fieldset className="storage-fields" disabled={busy}>
    <label>存储服务商<select value={target.provider} onChange={e => selectProvider(e.target.value as StorageTarget['provider'])}>
      {storageProviders.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <div className="form-pair">
      <label>{generic ? '签名区域' : '存储桶地域'}<input required list="storage-regions" value={target.region} placeholder={preset.regions[0]} onChange={e => update('region', e.target.value)} /></label>
      <datalist id="storage-regions">{preset.regions.map(r => <option value={r} key={r} />)}</datalist>
      <label>{cos ? '存储桶名称（含 APPID）' : 'Bucket'}<input required value={target.bucket} placeholder={cos ? 'photos-1250000000' : '存储桶名称'} onChange={e => update('bucket', e.target.value)} /></label>
    </div>
    {generic ? <>
      <label>Endpoint<input type="url" required value={target.endpoint} placeholder="https://…" onChange={e => update('endpoint', e.target.value)} /></label>
      <label>寻址方式<select value={target.virtualHost ? 'host' : 'path'} onChange={e => update('virtualHost', e.target.value === 'host')}>
        <option value="path">路径式 · endpoint/bucket</option><option value="host">虚拟主机 · bucket.endpoint</option></select></label>
    </> : <>
      <p className="storage-endpoint">区域服务地址 <code>{region && template.replace('{region}', region)}</code></p>
      {target.provider === 'aliyun' && <label>自定义域名（可选）<input type="url" value={target.customDomain} placeholder="https://images.example.com"
        aria-describedby="oss-domain-note" onChange={e => update('customDomain', e.target.value)} />
        <small id="oss-domain-note">如阿里云限制默认公网域名，请填写已绑定到这个桶的 HTTPS 域名。</small></label>}
    </>}
    <label>对象前缀<input value={target.prefix} placeholder="可留空" onChange={e => update('prefix', e.target.value)} /></label>
    <div className="form-pair">
      <label>{cos ? 'SecretId' : 'Access Key ID'}<input required value={target.accessKey} autoComplete="off" onChange={e => update('accessKey', e.target.value)} /></label>
      <label>{cos ? 'SecretKey' : 'Secret Access Key'}<input type="password" required={!savedKey} autoComplete="new-password" value={secret} placeholder={savedKey ? '已保存，留空沿用' : '输入存储密钥'} onChange={e => setSecret(e.target.value)} /></label>
    </div>
    <label className="check-line"><input type="checkbox" checked={target.automatic} onChange={e => update('automatic', e.target.checked)} />生成图片后自动上传</label>
    </fieldset>
    <div className="form-end"><button className="primary" disabled={busy}>保存对象存储</button>{feedback}</div>
  </form>
}
