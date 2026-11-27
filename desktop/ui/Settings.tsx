import { useEffect, useState, type FormEvent } from 'react'
import type { Integrations, StorageTarget } from '../shared'
import { WriterConnections, type WriterSelection } from './WriterConnections'
import storageProviders from '../../src/StorageProviders.json'
import { MediaToolSettings } from './MediaToolSettings'
import { RuntimeSettings } from './RuntimeSettings'
import { UpdateSettings, type AppUpdates } from './UpdateSettings'
import { PerformanceSettings } from './PerformanceSettings'
import { DeveloperSettings } from './RequestHistory'
import { MediaConnections, type MediaConnectionProps } from './MediaConnections'

const sections = { media: '图片与视频', writer: '剧本模型', storage: '对象存储', performance: '性能', files: '文件与工具', developer: '开发者模式', updates: '软件更新' }
export type SettingsSection = keyof typeof sections

interface Props extends MediaConnectionProps, WriterSelection {
  updates: AppUpdates
  section: SettingsSection
  select: (section: SettingsSection) => void
  integrations?: Integrations
  editActiveWriter: boolean
  reload: () => Promise<void>
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
    <div className={section === 'media' || section === 'writer' ? 'preferences-content media-preferences' : 'preferences-content'} key={section}>
      <h2>{sections[section]}</h2>
      {section === 'updates' && <UpdateSettings updates={props.updates}/>}
      {section === 'media' && <MediaConnections profiles={props.profiles} official={official} edit={props.edit} remove={props.remove} addModel={props.addModel} />}
      {section === 'writer' && integrations && <WriterConnections data={integrations} reload={props.reload} editActive={props.editActiveWriter}
        selectWriter={props.selectWriter} switchingWriter={props.switchingWriter} />}
      {section === 'storage' && integrations && <StorageForm data={integrations} reload={props.reload} />}
      {section === 'performance' && integrations && <PerformanceSettings mode={integrations.performance} reload={props.reload} />}
      {section === 'developer' && integrations && <DeveloperSettings enabled={integrations.developerMode} reload={props.reload}/>}
      {(section === 'writer' || section === 'storage' || section === 'performance' || section === 'developer') && !integrations &&
        <button onClick={() => void props.reload().catch(() => {})}>重新读取设置</button>}
      {section === 'files' && <><RuntimeSettings/><MediaToolSettings/>
        <div className="preference-row"><div><h3>本地作品</h3><p>查看已保存的原图、视频和导出副本。</p></div>
          <button onClick={props.folder}>打开作品目录</button></div>
        <div className="preference-row"><div><h3>网站工作台</h3><p>复制创作台的当前提示词，并打开官网。</p></div>
          <button onClick={props.website}>网站工作台 ↗</button></div>
      </>}
      {(section === 'media' || section === 'writer' || section === 'storage') && <p className="vault-note">{props.keyStorage}</p>}
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
