import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { ModelCatalog, ModelLookup } from '../shared'

export function useModelCatalog(query: ModelLookup) {
  const [result, setResult] = useState<ModelCatalog>()
  const [loading, setLoading] = useState(false), [error, setError] = useState('')
  const request = useRef(0)
  useLayoutEffect(() => {
    setResult(undefined)
    setError('')
    setLoading(false)
    return () => { request.current++ }
  }, [query.base, query.key, query.auth, query.id, query.source])

  async function fetchModels() {
    const current = ++request.current
    setLoading(true)
    setError('')
    try {
      const found = await window.studio.discoverModels(query)
      if (current === request.current) setResult(found)
    } catch (e) {
      if (current === request.current) {
        setResult(undefined)
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (current === request.current) setLoading(false)
    }
  }

  function baseForSave(savedBase: string | undefined, inferVersion: boolean) {
    let url: URL
    try { url = new URL(query.base.trim()) } catch { return query.base }
    const entered = url.href.replace(/\/+$/, '')
    // An existing connection may serve generation at its root and publish a versioned catalog.
    if (entered === savedBase) return query.base
    if (!url.search && !url.hash && url.pathname.replace(/\/+$/, '').endsWith('/models'))
      return entered.slice(0, -'/models'.length)
    return inferVersion && result ? result.base : query.base
  }
  return { models: result?.models, loading, error, fetchModels, baseForSave }
}

interface Props {
  label: string
  value: string
  change: (value: string) => void
  catalog: ReturnType<typeof useModelCatalog>
  canFetch: boolean
  disabled: boolean
  hints?: string[]
}

export function ModelPicker({ label, value, change, catalog, canFetch, disabled, hints }: Props) {
  const field = useId()
  const [manual, setManual] = useState(false)
  const models = catalog.models ?? []
  const suggestions = models.length ? models : hints
  const choosing = models.length > 0 && !manual
  return <div className="model-picker" aria-busy={catalog.loading}>
    <div className="model-picker-heading">
      <label htmlFor={field}>{label}</label>
      <button type="button" aria-controls={field} disabled={disabled || !canFetch || catalog.loading}
        onClick={() => { setManual(false); void catalog.fetchModels() }}>
        {catalog.loading ? '正在获取…' : '获取模型列表'}
      </button>
    </div>
    {choosing ? <select id={field} aria-label="从服务商选择模型" value={value} required disabled={disabled} onChange={e => change(e.target.value)}>
      {!value && <option value="">请选择模型</option>}
      {value && !models.includes(value) && <option value={value}>{value}（当前填写）</option>}
      {models.map(id => <option key={id} value={id}>{id}</option>)}
    </select> : <>
      <input id={field} required disabled={disabled} value={value} placeholder="获取列表后选择，或手动填写模型 ID"
        list={suggestions?.length ? field + '-hints' : undefined} onChange={e => change(e.target.value)} />
      {!!suggestions?.length && <datalist id={field + '-hints'}>{suggestions.map(id => <option key={id} value={id} />)}</datalist>}
    </>}
    <div className="model-picker-feedback">
      <span role="status" className={catalog.error ? 'error' : 'help'}>
        {catalog.error || (catalog.models && (models.length ? `已获取 ${models.length} 个模型` : '服务返回了空列表，可手动填写模型 ID。'))}
      </span>
      {models.length > 0 && <button type="button" className="link" disabled={disabled} onClick={() => setManual(!manual)}>
        {choosing ? '手动填写' : '从列表选择'}</button>}
    </div>
  </div>
}
