import { useState, type FormEvent } from 'react'
import {
  groupWriters, serviceGroupIds, serviceGroupNames, suggestedServiceGroup, writerName,
  type Integrations, type WriterService,
} from '../shared'
import { ConnectionCard, ConnectionGroup } from './ConnectionCards'
import { Modal } from './Editor'
import { AdditionalModels, ModelPicker, parseModelIds, useModelCatalog } from './ModelPicker'

export interface WriterSelection {
  selectWriter: (id: string, model: string) => void
  switchingWriter: boolean
}

export function WriterSelector({ data, selectWriter, disabled }: {
  data: Integrations; selectWriter: WriterSelection['selectWriter']; disabled: boolean
}) {
  return <label>剧本服务与模型
    <select value={JSON.stringify([data.writer.id, data.writer.model])} disabled={disabled}
      onChange={e => { const [id, model] = JSON.parse(e.target.value) as [string, string]; selectWriter(id, model) }}>
      {groupWriters(data.writers).flatMap(group => group.profiles.map(w =>
        <optgroup key={w.id} label={`${group.name} · ${writerName(w)}`}>
          {w.models.map(model => <option key={model} value={JSON.stringify([w.id, model])}>{writerName(w)} · {model}</option>)}
        </optgroup>))}
    </select>
  </label>
}

interface SettingsProps extends WriterSelection {
  data: Integrations
  reload: () => Promise<void>
  editActive: boolean
}

export function WriterConnections({ data, reload, editActive, selectWriter, switchingWriter }: SettingsProps) {
  const { writer, writers } = data
  const [editor, edit] = useState<WriterService | 'new' | null>(() => editActive ? writer : null)
  const [removing, remove] = useState<WriterService | null>(null)
  const [busy, setBusy] = useState(false), [message, report] = useState('')
  const others = writers.filter(w => w.id !== writer.id)
  const fallback = others.find(w => w.hasKey) ?? others[0]
  async function refresh(message: string) {
    try { await reload(); report(message) }
    catch (e) { report(String(e)) }
  }
  async function confirmRemove() {
    if (!removing || busy) return
    setBusy(true)
    try {
      await window.studio.removeWriter(removing.id)
      remove(null)
      await refresh('剧本服务已移除。')
    } catch (e) { report(String(e)); remove(null) }
    finally { setBusy(false) }
  }
  return <>
    <section className="featured-connection writer-current" aria-labelledby="current-writer-title">
      <div>
        <h3 id="current-writer-title">当前剧本模型</h3>
        <div className="connection-identity"><h4>{writer.model}</h4>
          <span className="connection-key-state" data-configured={writer.hasKey}>{writerName(writer)} · {writer.hasKey ? 'Key 已配置' : 'Key 待配置'}</span>
        </div>
        <p>剧本生成、提示词优化和对话改稿共用当前模型。</p>
      </div>
    </section>
    <section className="external-connections" aria-labelledby="writer-services-title">
      <header className="connections-heading">
        <h3 id="writer-services-title">我的剧本服务</h3>
        <button className="add-connection" disabled={switchingWriter} onClick={() => { report(''); edit('new') }}>
          <span aria-hidden="true">＋</span>添加剧本服务
        </button>
      </header>
      {groupWriters(writers).map(group => <ConnectionGroup key={group.id} name={group.name} count={group.profiles.length}>
        {group.profiles.map(w => <li key={w.id}>
          <ConnectionCard name={writerName(w)} description={w.hasKey ? 'Key 已配置' : 'Key 待配置'} base={w.base} modelLabel="文本模型"
            actions={<>
              <button aria-label={`编辑 ${writerName(w)}`} disabled={switchingWriter} onClick={() => { report(''); edit(w) }}>编辑</button>
              <button aria-label={`移除 ${writerName(w)}`} disabled={switchingWriter} onClick={() => { report(''); remove(w) }}>移除</button>
            </>}>
            {w.models.map(model => <li className="writer-model-row" key={model}><code>{model}</code>
              {w.id === writer.id && model === writer.model ? <small aria-current="true">当前使用</small> :
                <button type="button" className="link" disabled={switchingWriter}
                  aria-label={`使用 ${writerName(w)} 的 ${model}`} onClick={() => { report(''); selectWriter(w.id, model) }}>使用</button>}
            </li>)}
          </ConnectionCard>
        </li>)}
      </ConnectionGroup>)}
    </section>
    {message && <p role="status" className="writer-feedback">{message}</p>}
    {editor && <WriterEditor service={editor === 'new' ? undefined : editor} active={writer} close={() => edit(null)}
      saved={() => { edit(null); void refresh('设置已保存。') }} />}
    {removing && <Modal title="移除剧本服务" close={() => { if (!busy) remove(null) }}>
      <p>移除「{writerName(removing)}」及其保存的文本模型和 Key？</p>
      {removing.id === writer.id && <p>{fallback ? `移除后将使用「${writerName(fallback)} · ${fallback.model}」。` : '移除后将恢复为待配置的 DeepSeek 连接。'}</p>}
      <footer className="modal-actions"><button disabled={busy} onClick={() => remove(null)}>取消</button>
        <button disabled={busy} onClick={() => void confirmRemove()}>移除服务</button></footer>
    </Modal>}
  </>
}

function WriterEditor({ service, active, close, saved }: {
  service?: WriterService; active: WriterService; close: () => void; saved: () => void
}) {
  const [name, setName] = useState(service?.name ?? '')
  const [base, setBase] = useState(service?.base ?? ''), [key, setKey] = useState('')
  const [group, setGroup] = useState<WriterService['serviceGroup']>(service?.serviceGroup ?? 'auto')
  const [model, setModel] = useState(service?.model ?? '')
  const [extras, setExtras] = useState(service?.models.filter(m => m !== service.model).join('\n') ?? '')
  const [activate, setActivate] = useState(!service && !active.hasKey)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const id = service?.id ?? '@new'
  const catalog = useModelCatalog({ source: 'writer', id, base, key })
  const sameBase = base.trim().replace(/\/+$/, '') === service?.base
  function changeModel(next: string) {
    const alternatives = parseModelIds(extras)
    if (model.trim() && next !== model && alternatives.includes(next)) {
      setExtras(alternatives.map(value => value === next ? model : value).join('\n'))
    }
    setModel(next)
  }
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || catalog.loading) return
    setBusy(true); setError('')
    try {
      await window.studio.saveWriter({ id, name, serviceGroup: group, base: catalog.baseForSave(service?.hasKey ? service.base : undefined, true),
        key, model, models: parseModelIds(extras), activate })
      saved()
    } catch (e) { setError(String(e)); setBusy(false) }
  }
  return <Modal title={service ? '编辑剧本服务' : '添加剧本服务'} close={() => { if (!busy) close() }}>
    <form onSubmit={submit}>
      <div className="dialog-body fields">
        <fieldset className="connection-fields" disabled={busy}>
          <legend>服务连接</legend>
          <label>服务分组<select value={group} onChange={e => setGroup(e.target.value as WriterService['serviceGroup'])}>
            <option value="auto">自动分组（{serviceGroupNames[suggestedServiceGroup('chat-completions', base)]}）</option>
            {serviceGroupIds.map(id => <option key={id} value={id}>{serviceGroupNames[id]}</option>)}
          </select></label>
          <label>服务名称（可选）<input value={name} onChange={e => setName(e.target.value)}
            placeholder={base ? writerName({ name: '', base }) : '例如：我的剧本中转站'} /></label>
          <label>剧本服务地址<input type="url" required value={base} placeholder="https://relay.example/v1"
            onChange={e => { setBase(e.target.value); setKey('') }} /></label>
          <label>剧本 API Key<input type="password" autoComplete="new-password" value={key} onChange={e => setKey(e.target.value)}
            placeholder={service?.hasKey && sameBase ? '已保存，留空沿用' : '输入这个服务的 API Key'} /></label>
        </fieldset>
        <fieldset className="connection-fields" disabled={busy}>
          <legend>此服务的文本模型</legend>
          <p className="help">使用 Chat Completions 兼容接口。生成剧本需要模型支持 JSON 输出。</p>
          <ModelPicker label="剧本模型 ID" value={model} change={changeModel} catalog={catalog} canFetch={!!base.trim()} disabled={busy}
            hints={base.trim().replace(/\/+$/, '') === 'https://api.deepseek.com' ? ['deepseek-v4-pro', 'deepseek-flash'] : undefined} />
          <AdditionalModels text={extras} change={setExtras} primary={model} catalog={catalog.models ?? []} hint="每行一个，与上面的模型共用服务地址和 Key" />
        </fieldset>
        {id !== active.id && <label className="check"><input type="checkbox" checked={activate} disabled={busy}
          onChange={e => setActivate(e.target.checked)} />保存后使用这个服务和模型</label>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <footer className="modal-actions"><button type="button" disabled={busy} onClick={close}>取消</button>
        <button className="primary" disabled={busy || catalog.loading}>{busy ? '正在保存…' : '保存剧本模型'}</button></footer>
    </form>
  </Modal>
}
