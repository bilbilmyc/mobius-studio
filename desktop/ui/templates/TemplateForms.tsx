import { useState } from 'react'
import {
  fillTemplate,
  templateFields,
  type PromptTemplate,
  type TemplateSpec,
  type TemplateMedium,
} from '../../agent/templates'
export const mediaLabels = { any: '通用', image: '图片', video: '视频' }

export function TemplatePreview({
  entry,
  maxLength,
  applyLabel,
  apply,
  disabled,
}: {
  entry: PromptTemplate
  maxLength: number
  applyLabel: string
  apply: (text: string) => void
  disabled: boolean
}) {
  const fields = templateFields(entry.body)
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields))
  const [excerpt, setExcerpt] = useState('')
  const text = fillTemplate(entry.body, values)
  const long = text.length > maxLength
  const output = long ? excerpt : text
  const incomplete = [...fields.keys()].some((name) => !values[name]?.trim())
  return (
    <section className="template-preview">
      {entry.description && <small>{entry.description}</small>}
      {(entry.author || entry.source) && (
        <small>
          {[entry.author && '作者 ' + entry.author, entry.source && '来源 ' + entry.source]
            .filter(Boolean)
            .join(' · ')}
        </small>
      )}
      {fields.size > 0 && (
        <div className="template-variables">
          {[...fields.keys()].map((name) => (
            <label key={name}>
              {name}
              <input
                value={values[name] ?? ''}
                maxLength={2000}
                onChange={(e) => {
                  setValues({ ...values, [name]: e.target.value })
                  setExcerpt('')
                }}
              />
            </label>
          ))}
        </div>
      )}
      <pre aria-label="模板使用预览">{text}</pre>
      {long && (
        <>
          <label>
            本次使用的节选
            <textarea
              value={excerpt}
              maxLength={maxLength}
              placeholder={'从上方全文中选取本次使用的段落，最多 ' + maxLength + ' 字。'}
              onChange={(e) => setExcerpt(e.target.value)}
            />
          </label>
          <button
            className="link"
            disabled={maxLength <= 0}
            onClick={() => setExcerpt(text.slice(0, maxLength))}
          >
            取前 {maxLength} 字作为节选
          </button>
        </>
      )}
      <button
        className="primary"
        disabled={disabled || (!long && incomplete) || !output.trim() || output.length > maxLength}
        onClick={() => apply(output)}
      >
        {applyLabel}
      </button>
    </section>
  )
}

export function TemplateEditor({
  draft,
  change,
  save,
  cancel,
  disabled,
}: {
  draft: TemplateSpec
  change: (d: TemplateSpec) => void
  save: () => void
  cancel: () => void
  disabled: boolean
}) {
  return (
    <div className="template-edit">
      <label>
        模板名称
        <input
          value={draft.name}
          maxLength={256}
          onChange={(e) => change({ ...draft, name: e.target.value })}
        />
      </label>
      <label>
        适用媒体
        <select
          value={draft.medium}
          onChange={(e) => change({ ...draft, medium: e.target.value as TemplateMedium })}
        >
          {(Object.keys(mediaLabels) as TemplateMedium[]).map((k) => (
            <option key={k} value={k}>
              {mediaLabels[k]}
            </option>
          ))}
        </select>
      </label>
      <label>
        模板说明
        <input
          value={draft.description}
          maxLength={800}
          onChange={(e) => change({ ...draft, description: e.target.value })}
        />
      </label>
      <details>
        <summary>署名与来源</summary>
        <label>
          作者
          <input
            value={draft.author ?? ''}
            maxLength={256}
            onChange={(e) => change({ ...draft, author: e.target.value })}
          />
        </label>
        <label>
          来源
          <input
            value={draft.source ?? ''}
            maxLength={2000}
            onChange={(e) => change({ ...draft, source: e.target.value })}
          />
        </label>
      </details>
      <label>
        模板正文
        <textarea
          value={draft.body}
          maxLength={262144}
          placeholder="可以用 {{主体}} 留出填空位置。"
          onChange={(e) => change({ ...draft, body: e.target.value })}
        />
      </label>
      <div className="template-actions">
        <button disabled={disabled || !draft.name.trim() || !draft.body.trim()} onClick={save}>
          保存模板
        </button>
        <button onClick={cancel}>取消编辑</button>
      </div>
    </div>
  )
}
