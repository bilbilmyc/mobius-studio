import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Modal } from './Editor'
export interface Features {
  sizes: string[]
  maxImages: number | null
  firstLast: boolean | null
  mask: boolean | null
  multi: number | null
}
interface Evidence {
  declared: Features | null
  listed: boolean
  tested: {
    size: string
    references: number
    mode: string
    mask: boolean
    results: number
    at: number
  }[]
}
const blank: Features = { sizes: [], maxImages: null, firstLast: null, mask: null, multi: null }
export function useFeatures(profileId?: string, model?: string) {
  const [record, set] = useState<{ key: string; e: Evidence }>(),
    [error, setError] = useState('')
  const key = JSON.stringify([profileId, model])
  const activeKey = useRef(key)
  activeKey.current = key
  const load = useCallback(async () => {
    if (!profileId || !model) return
    const e = await invoke<Evidence>('get_model_features', { profileId, model })
    if (activeKey.current === key) {
      set({ key, e })
      setError('')
    }
  }, [key])
  useEffect(() => {
    setError('')
    void load().catch((e) => setError(String(e)))
  }, [load])
  return { e: record?.key === key ? record.e : undefined, load, error }
}
export function ModelFeatures({
  profileId,
  model,
  record,
  saved,
}: {
  saved: () => Promise<unknown>
  profileId: string
  model: string
  record: ReturnType<typeof useFeatures>
}) {
  const [open, show] = useState(false),
    [f, set] = useState<Features>(blank),
    [sizes, setSizes] = useState(''),
    [error, say] = useState(''),
    [busy, lock] = useState(false)
  const flag = (key: 'firstLast' | 'mask', label: string) => (
    <label>
      {label}
      <select
        value={f[key] == null ? '' : String(f[key])}
        onChange={(e) => set({ ...f, [key]: e.target.value === '' ? null : e.target.value === 'true' })}
      >
        <option value="">未声明</option>
        <option value="true">支持</option>
        <option value="false">不支持</option>
      </select>
    </label>
  )
  async function save() {
    lock(true)
    try {
      await invoke('set_model_features', {
        profileId,
        model,
        features: {
          ...f,
          sizes: sizes
            .split(/[,，\n]/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
      })
      await Promise.all([record.load(), saved()])
      show(false)
    } catch (e) {
      say(String(e))
    } finally {
      lock(false)
    }
  }
  return (
    <>
      <button
        onClick={() => {
          const current = record.e?.declared ?? blank
          set(current)
          setSizes(current.sizes.join('，'))
          say('')
          show(true)
          void record.load().catch((e) => say(String(e)))
        }}
      >
        模型能力与实测
      </button>
      {open && (
        <Modal title="模型能力与实测" close={() => show(false)}>
          <div className="project-tools">
            <h3>{model}</h3>
            <p>
              {record.e?.listed ? '已从服务目录发现' : '暂无目录记录'} ·{' '}
              {record.e?.declared ? '已手工声明' : '沿用连接参数'} ·{' '}
              {record.e?.tested.length ? '已有生成实测' : '尚无成功生成记录'}
            </p>
            <label>
              可用尺寸或画幅（逗号分隔）
              <input value={sizes} onChange={(e) => setSizes(e.target.value)} />
            </label>
            <label>
              最多参考图
              <input
                type="number"
                min="0"
                max="64"
                value={f.maxImages ?? ''}
                onChange={(e) =>
                  set({ ...f, maxImages: e.target.value === '' ? null : Number(e.target.value) })
                }
              />
            </label>
            {flag('firstLast', '首尾帧')}
            {flag('mask', '遮罩编辑')}
            <label>
              单次请求最多图片数
              <select
                value={f.multi ?? ''}
                onChange={(e) => set({ ...f, multi: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">未声明</option>
                {[1, 2, 4].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            {!!record.e?.tested.length && (
              <ul>
                {record.e.tested.map((t, i) => (
                  <li key={i}>
                    {new Date(t.at).toLocaleString()} · {t.size} · {t.mode} · {t.references} 张参考 ·{' '}
                    {t.results} 个结果{t.mask ? ' · 使用遮罩' : ''}
                  </li>
                ))}
              </ul>
            )}
            <button disabled={busy} onClick={() => void save()}>
              保存模型能力
            </button>
            {(error || record.error) && <p role="alert">{error || record.error}</p>}
          </div>
        </Modal>
      )}
    </>
  )
}
