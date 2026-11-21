import { useState } from 'react'
import {
  defaultWorkflow,
  modeLabels,
  isCustom,
  mediaKind,
  presets,
  type Controls,
  type Protocol,
  type RelayMap,
  type Workflow,
  type Parameter,
  type Value,
} from '../shared'
export function ParameterField({
  spec,
  value,
  change,
}: {
  spec: Parameter
  value: Value
  change: (v: Value) => void
}) {
  if (spec.type === 'boolean')
    return (
      <label className="check">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => change(e.target.checked)}
        />
        {spec.label}
      </label>
    )
  return (
    <label>
      {spec.label}
      {spec.type === 'select' ? (
        <select value={String(value)} onChange={(e) => change(e.target.value)}>
          {spec.choices?.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      ) : spec.type === 'number' ? (
        <input
          type="number"
          step="any"
          min={spec.min}
          max={spec.max}
          value={String(value)}
          onChange={(e) =>
            change(e.target.value === '' ? '' : Number(e.target.value))
          }
        />
      ) : (
        <input value={String(value)} onChange={(e) => change(e.target.value)} />
      )}
    </label>
  )
}
export function ExtraParameters({
  relay,
  change,
}: {
  relay: RelayMap
  change: (r: RelayMap) => void
}) {
  const [advanced, setAdvanced] = useState(false),
    [source, edit] = useState(''),
    [error, fail] = useState('')
  const list = relay.parameters ?? []
  const templates: Parameter[] = [
    { key: 'seed', label: '随机种子', type: 'number', default: -1, min: -1 },
    { key: 'negative_prompt', label: '负面提示词', type: 'text', default: '' },
    {
      key: 'quality',
      label: '画质',
      type: 'select',
      choices: ['standard', 'high'],
      default: 'standard',
    },
    { key: 'watermark', label: '水印', type: 'boolean', default: false },
  ]
  function add(p: Parameter) {
    const addField = (s: string) => {
      const body = JSON.parse(s)
      if (!body || Array.isArray(body) || typeof body !== 'object')
        throw Error('请先填写有效的请求对象。')
      if (p.key in body)
        throw Error('请求体已包含同名字段，请在参数定义中配置占位符。')
      return JSON.stringify(
        { ...body, [p.key]: '{{params.' + p.key + '}}' },
        null,
        2,
      )
    }
    try {
      const workflows = Object.fromEntries(
        Object.entries(relay.workflows ?? {}).map(([k, w]) => [
          k,
          { ...w, body: addField(w.body) },
        ]),
      )
      change({
        ...relay,
        body: addField(relay.body),
        workflows,
        parameters: [...list, p],
      })
      fail('')
    } catch (e) {
      fail(String(e))
    }
  }
  return (
    <fieldset>
      <legend>创作台可调参数</legend>
      <div className="asset-tools">
        {templates
          .filter((p) => !list.some((v) => v.key === p.key))
          .map((p) => (
            <button type="button" key={p.key} onClick={() => add(p)}>
              ＋ {p.label}
            </button>
          ))}
      </div>
      {list.length > 0 && <small>{list.map((p) => p.label).join('、')}</small>}
      <button
        type="button"
        className="link align-left"
        onClick={() => {
          edit(JSON.stringify(list, null, 2))
          setAdvanced(!advanced)
        }}
      >
        {advanced ? '收起定义' : '编辑参数定义'}
      </button>
      {advanced && (
        <>
          <label>
            参数定义 JSON
            <textarea
              rows={6}
              value={source}
              onChange={(e) => edit(e.target.value)}
            />
          </label>
          <small>
            {
              '每项填写 key、label、type、default。type 可用 text、number、boolean、select，下拉选项写入 choices。请求体引用 {{params.字段名}}。'
            }
          </small>
          <button
            type="button"
            onClick={() => {
              try {
                const v = JSON.parse(source)
                if (
                  !Array.isArray(v) ||
                  v.some(
                    (p) =>
                      !p ||
                      typeof p.key !== 'string' ||
                      typeof p.label !== 'string' ||
                      !['text', 'number', 'boolean', 'select'].includes(p.type),
                  )
                )
                  throw Error('参数定义格式无效')
                change({ ...relay, parameters: v })
                setAdvanced(false)
                fail('')
              } catch (e) {
                fail(String(e))
              }
            }}
          >
            应用参数定义
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  )
}
export function WorkflowSettings({
  protocol,
  relay,
  change,
}: {
  protocol: Protocol
  relay: RelayMap
  change: (v: RelayMap) => void
}) {
  const workflows = relay.workflows ?? {},
    modes =
      mediaKind(protocol) === 'image'
        ? ['i2i']
        : ['first_frame', 'first_last', 'reference']
  function set(mode: string, w?: Workflow) {
    const next = { ...workflows }
    if (w) next[mode] = w
    else delete next[mode]
    change({ ...relay, workflows: next })
  }
  const encoding = (
    value: string | undefined,
    update: (v: 'json' | 'multipart') => void,
  ) => (
    <label>
      请求格式
      <select
        value={value || 'json'}
        onChange={(e) => update(e.target.value as 'json' | 'multipart')}
      >
        <option value="json">JSON</option>
        <option value="multipart">Multipart 文件表单</option>
      </select>
    </label>
  )
  return (
    <fieldset>
      <legend>带素材的创作方式</legend>
      {modes.map((mode) => {
        const w = workflows[mode]
        return (
          <div className="workflow" key={mode}>
            <label className="check">
              <input
                type="checkbox"
                checked={!!w}
                onChange={(e) =>
                  set(
                    mode,
                    e.target.checked ? defaultWorkflow(mode) : undefined,
                  )
                }
              />
              {modeLabels[mode]}
            </label>
            {w && (
              <div className="fields">
                <label>
                  {modeLabels[mode]}提交路径
                  <input
                    required
                    value={w.submit}
                    onChange={(e) =>
                      set(mode, { ...w, submit: e.target.value })
                    }
                  />
                </label>
                {encoding(w.encoding, (v) => set(mode, { ...w, encoding: v }))}
                <label>
                  {modeLabels[mode]}请求体
                  <textarea
                    rows={6}
                    value={w.body}
                    onChange={(e) => set(mode, { ...w, body: e.target.value })}
                  />
                </label>
              </div>
            )}
          </div>
        )
      })}
      <small>
        {
          'JSON 可用 {{images}}、{{first_frame}}、{{last_frame}}、{{videos}}、{{audios}}。本地素材转成 data URL，HTTPS 链接按原地址传递。Multipart 的顶层字段可直接引用同一占位符上传文件。'
        }
      </small>
    </fieldset>
  )
}
export function ControlSettings({
  protocol,
  controls,
  change,
}: {
  protocol: Protocol
  controls: Controls
  change: (v: Controls) => void
}) {
  const raw = (s: string) => s.split(/[,，]/).map((x) => x.trim())
  const preset = presets[protocol],
    custom = isCustom(protocol)
  return (
    <details className="protocol-options">
      <summary>模型支持的输出参数</summary>
      <div className="fields">
        {!custom && (
          <label>
            可选尺寸或画幅（逗号分隔）
            <input
              defaultValue={controls.sizes.join(',')}
              placeholder={preset.sizes.join(', ')}
              onChange={(e) =>
                change({
                  ...controls,
                  sizes: e.target.value ? raw(e.target.value) : [],
                })
              }
            />
          </label>
        )}
        {!custom && mediaKind(protocol) === 'video' && (
          <label>
            可选时长（秒）
            <input
              defaultValue={controls.seconds.join(',')}
              placeholder={preset.seconds.join(', ')}
              onChange={(e) =>
                change({
                  ...controls,
                  seconds: e.target.value
                    ? raw(e.target.value).map(Number)
                    : [],
                })
              }
            />
          </label>
        )}
        {(custom || (preset.resolutions?.length ?? 0) > 0) && (
          <label>
            分辨率选项
            <input
              defaultValue={controls.resolutions.join(',')}
              placeholder={
                preset.resolutions?.join(', ') || '480p, 720p, 1080p'
              }
              onChange={(e) =>
                change({
                  ...controls,
                  resolutions: e.target.value ? raw(e.target.value) : [],
                })
              }
            />
          </label>
        )}
        {custom && (
          <label>
            独立的画幅选项
            <input
              defaultValue={controls.ratios.join(',')}
              placeholder="16:9, 9:16, 1:1"
              onChange={(e) =>
                change({
                  ...controls,
                  ratios: e.target.value ? raw(e.target.value) : [],
                })
              }
            />
          </label>
        )}
        {(custom ||
          protocol.startsWith('openai-') ||
          protocol === 'wan-image' ||
          protocol === 'wan-video') && (
          <label className="check">
            <input
              type="checkbox"
              checked={controls.customSize}
              onChange={(e) =>
                change({ ...controls, customSize: e.target.checked })
              }
            />
            允许填写自定义像素尺寸
          </label>
        )}
      </div>
    </details>
  )
}
