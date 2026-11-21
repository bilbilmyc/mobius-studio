import React, { useState } from 'react'
import {
  defaultRelay,
  emptyControls,
  defaultTemplate,
  isCustom,
  isSite,
  mediaKind,
  presets,
  siteBase,
  type EditProfile,
  type ProfileView,
  type Protocol,
  type RelayMap,
} from '../shared'
import { Modal } from './Editor'
import { ModelPicker, useModelCatalog } from './ModelPicker'
import {
  WorkflowSettings,
  ControlSettings,
  ExtraParameters,
} from './ProtocolSettings'

export function ConnectionEditor({
  profile,
  official,
  kind,
  storage,
  close,
  saved,
}: {
  profile?: ProfileView
  official: boolean
  kind: 'image' | 'video'
  storage: string
  close: () => void
  saved: (id: string) => Promise<void>
}) {
  const [p, set] = useState<EditProfile>(() => ({
    id: official ? '@site' : profile?.Id,
    name: official ? 'AIGC 创作空间' : (profile?.Name ?? ''),
    protocol: official
      ? 'rh-image'
      : (profile?.ProtocolId ??
        (kind === 'image' ? 'openai-image' : 'openai-video')),
    base: official ? siteBase : (profile?.BaseUrl ?? ''),
    model: official ? defaultTemplate('image').Key : (profile?.Model ?? ''),
    key: '',
    relay: profile?.Relay,
  }))
  const [relay, setRelay] = useState<RelayMap>(
      () => profile?.Relay ?? defaultRelay(kind),
    ),
    [err, error] = useState(''),
    [busy, work] = useState(false)
  const catalog = useModelCatalog({
    source: p.protocol === 'comfy-image' ? 'comfy' : 'connection', id: p.id, base: p.base, key: p.key,
    auth: isCustom(p.protocol) ? relay.auth : 'bearer',
  })
  const models = catalog.models ?? []
  const [additional, setAdditional] = useState(profile?.Models?.join('\n') ?? '')
  const patch = (k: keyof EditProfile, v: string) => {
    set((old) => ({ ...old, ...(k === 'base' && v !== old.base ? { key: '' } : {}), [k]: v }))
  }
  const [controls, setControls] = useState(
    () => profile?.Controls ?? emptyControls(),
  )
  function select(id: Protocol) {
    set((old) => ({
      ...old,
      protocol: id,
      base: presets[id].base || old.base,
      model: presets[id].model,
      name: old.name || (id === 'comfy-image' ? '本机 ComfyUI' : ''),
      key: '',
    }))
    setRelay(defaultRelay(mediaKind(id)))
    setControls(emptyControls())
    setAdditional('')
    error('')
  }
  async function save() {
    work(true)
    error('')
    try {
      const input = {
        ...p,
        base: official || p.protocol === 'comfy-image' ? p.base : catalog.baseForSave(profile?.BaseUrl, p.protocol.startsWith('openai-')),
        models: official ? undefined : additional.split(/[\n,，]+/).map((s) => s.trim()).filter(Boolean),
        controls: official ? undefined : controls,
        relay: isCustom(p.protocol) ? relay : undefined,
      }
      await saved(await window.studio.save(input))
    } catch (e) {
      error(e instanceof Error ? e.message : String(e))
    } finally {
      work(false)
    }
  }
  const option = (k: keyof RelayMap, title: string, placeholder?: string) => (
    <label>
      {title}
      <input
        value={String(relay[k])}
        placeholder={placeholder}
        onChange={(e) => setRelay({ ...relay, [k]: e.target.value })}
      />
    </label>
  )
  return (
    <Modal
      title={
        official ? '官网连接' : profile ? '编辑模型服务' : '添加模型服务'
      }
      close={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="dialog-body fields">
          {official ? (
            <>
              <strong>AIGC 创作空间</strong>
              <p className="help">
                图片和视频默认使用此官网。OpenAPI Key 用于这个官网的生成任务。
              </p>
            </>
          ) : (
            <>
              <label>
                连接名称
                <input
                  required
                  value={p.name}
                  placeholder="例如：我的模型中转站"
                  onChange={(e) => patch('name', e.target.value)}
                />
              </label>
              <label>
                接口协议
                <select
                  value={p.protocol}
                  onChange={(e) => select(e.target.value as Protocol)}
                >
                  {(Object.keys(presets) as Protocol[])
                    .filter((id) => !isSite(id))
                    .map((id) => (
                      <option key={id} value={id}>
                        {presets[id].title}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                服务根地址
                <input
                  required
                  type="url"
                  value={p.base}
                  placeholder={p.protocol.startsWith('wan-') ? '百炼工作空间的服务地址，含 /api/v1' : 'https://你的服务商/v1'}
                  onChange={(e) => patch('base', e.target.value)}
                />
              </label>
              {p.protocol === 'openai-image' && p.base !== 'https://api.openai.com/v1' && (
                <button type="button" className="link align-left" onClick={() => patch('base', 'https://api.openai.com/v1')}>使用 OpenAI 官方地址</button>
              )}
            </>
          )}
          {p.protocol === 'comfy-image' && <p className="help">连接已启动的 ComfyUI，获取本机已安装的 SD 1.x 或 SDXL checkpoint。普通本机服务可将 Key 留空。</p>}
          <label>
            API Key
            <input
              type="password"
              autoComplete="new-password"
              value={p.key}
              placeholder={profile?.hasKey ? '同一地址留空可沿用已保存的 Key' : '填写此服务签发的 Key'}
              onChange={(e) => patch('key', e.target.value)}
            />
          </label>
          {!official && <>
              <ModelPicker label="模型 ID" value={p.model} change={value => patch('model', value)}
                catalog={catalog} canFetch={!!p.base.trim()} disabled={busy} />
              <details>
                <summary>同一连接的其他模型</summary>
                <label>
                  备选模型 ID
                  <textarea rows={3} value={additional} placeholder="每行一个，与上面的模型共用接口协议和输出参数"
                    onChange={(e) => setAdditional(e.target.value)} />
                </label>
                {models.length > 0 && (
                  <label>
                    从列表加入备选模型
                    <select value="" onChange={(e) => {
                      const value = e.target.value
                      if (value) setAdditional((old) => [old.trim(), value].filter(Boolean).join('\n'))
                    }}>
                      <option value="">选择要加入的模型</option>
                      {models.filter((m) => m !== p.model && !additional.split(/[\n,，]+/).some((s) => s.trim() === m))
                        .map((m) => <option key={m}>{m}</option>)}
                    </select>
                  </label>
                )}
              </details>
          </>}
          <small>{storage}</small>
          <label className="check">
            <input
              type="checkbox"
              checked={!!p.sessionOnly}
              onChange={(e) => set({ ...p, sessionOnly: e.target.checked })}
            />
            新填的 Key 仅在本次打开期间使用
          </label>
          {isCustom(p.protocol) && (
            <fieldset>
              <legend>接口映射</legend>
              <p className="help">
                填写相对于服务根地址的路径。字段用点号分隔，例如
                data.0.url。轮询路径留空表示同步返回结果。
              </p>
              <label>
                认证方式
                <select
                  value={relay.auth}
                  onChange={(e) =>
                    setRelay({
                      ...relay,
                      auth: e.target.value as RelayMap['auth'],
                    })
                  }
                >
                  {[
                    'bearer',
                    'x-api-key',
                    'x-auth-token',
                    'x-goog-api-key',
                    'api-key',
                    'token',
                    'none',
                  ].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
              {option('submit', '提交路径')}
              <label>
                文字生成请求格式
                <select
                  value={relay.encoding || 'json'}
                  onChange={(e) =>
                    setRelay({
                      ...relay,
                      encoding: e.target.value as 'json' | 'multipart',
                    })
                  }
                >
                  <option value="json">JSON</option>
                  <option value="multipart">Multipart 表单</option>
                </select>
              </label>
              {option('poll', '轮询路径', 'tasks/{id}')}
              <label>
                请求体 JSON
                <textarea
                  rows={6}
                  value={relay.body}
                  onChange={(e) => setRelay({ ...relay, body: e.target.value })}
                />
                <small>
                  {
                    '可用 {{model}}、{{prompt}}、{{size}}、{{width}}、{{height}}、{{ratio}}、{{resolution}}、{{seconds}}。'
                  }
                </small>
              </label>
              <div className="two">
                {option('url', '结果 URL 字段')}
                {option('base64', 'Base64 字段')}
                {option('id', '任务 ID 字段')}
                {option('state', '状态字段')}
              </div>
              {option('error', '错误信息字段')}
              {relay.poll && (
                <>
                  <div className="two">
                    {option('success', '完成状态')}
                    {option('failure', '失败状态')}
                  </div>
                  {option('waiting', '进行中状态')}
                </>
              )}
              <label>
                可选画幅（逗号分隔）
                <input
                  value={relay.sizes.join(',')}
                  onChange={(e) =>
                    setRelay({ ...relay, sizes: e.target.value.split(',') })
                  }
                />
              </label>
              {mediaKind(p.protocol) === 'video' && (
                <label>
                  时长（秒，逗号分隔）
                  <input
                    defaultValue={relay.seconds.join(',')}
                    onChange={(e) =>
                      setRelay({
                        ...relay,
                        seconds: e.target.value.split(',').map(Number),
                      })
                    }
                  />
                </label>
              )}
            </fieldset>
          )}
          {isCustom(p.protocol) && (
            <>
              <WorkflowSettings
                protocol={p.protocol}
                relay={relay}
                change={setRelay}
              />
              <ExtraParameters relay={relay} change={setRelay} />
            </>
          )}
          {!official && (
            <ControlSettings
              key={p.protocol}
              protocol={p.protocol}
              controls={controls}
              change={setControls}
            />
          )}
          {err && (
            <p role="alert" className="error">
              {err}
            </p>
          )}
        </div>
        <footer className="modal-actions">
          <button type="button" onClick={close}>
            取消
          </button>
          <button className="primary" disabled={busy || catalog.loading}>
            {busy ? '处理中…' : '保存连接'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
