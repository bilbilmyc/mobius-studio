import { useState } from 'react'
import { invoke } from './ipc'
import type { Picked } from '../shared'
import { Modal } from './Editor'
interface Card {
  id: string
  name: string
  category: string
  description: string
  items: Picked[]
}
export function ReferenceCards({
  items,
  apply,
}: {
  items: Picked[]
  apply: (items: Picked[], description: string) => void
}) {
  const [open, setOpen] = useState(false),
    [cards, setCards] = useState<Card[]>([])
  const [name, setName] = useState(''),
    [category, setCategory] = useState('角色'),
    [description, setDescription] = useState('')
  const [selected, select] = useState(''),
    [withText, useText] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  async function load() {
    setCards(await invoke<Card[]>('list_cards'))
  }
  async function save() {
    setBusy(true)
    setError('')
    try {
      await invoke('save_card', {
        input: {
          id: selected || null,
          name,
          category,
          description,
          items: items.filter((i) => i.kind === 'image'),
        },
      })
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  function choose(c?: Card) {
    select(c?.id || '')
    setName(c?.name || '')
    setDescription(c?.description || '')
    setCategory(c?.category || '角色')
  }
  return (
    <>
      <button
        onClick={() => {
          setOpen(true)
          setError('')
          void load().catch((e) => setError(String(e)))
        }}
      >
        角色与场景卡
      </button>
      {open && (
        <Modal title="角色与场景卡" close={() => setOpen(false)}>
          <div className="project-tools">
            <label>
              素材卡
              <select
                value={selected}
                onChange={(e) => choose(cards.find((c) => c.id === e.target.value))}
              >
                <option value="">新建卡片</option>
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.category} · {c.name}（{c.items.length} 张）
                  </option>
                ))}
              </select>
            </label>
            {selected && (
              <>
                <ol>
                  {cards
                    .find((c) => c.id === selected)
                    ?.items.map((i) => (
                      <li key={i.token}>{i.name}</li>
                    ))}
                </ol>
                <label>
                  <input
                    type="checkbox"
                    checked={withText}
                    onChange={(e) => useText(e.target.checked)}
                  />
                  同时附加卡片描述到提示词
                </label>
                <button
                  onClick={() => {
                    try {
                      const c = cards.find((c) => c.id === selected)!
                      apply(c.items, withText ? c.description : '')
                      setOpen(false)
                    } catch (e) {
                      setError(String(e))
                    }
                  }}
                >
                  将卡片用于当前镜头
                </button>
              </>
            )}
            <label>
              分类
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option>角色</option>
                <option>场景</option>
              </select>
            </label>
            <label>
              卡片名称
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              描述
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <button
              disabled={busy || !name.trim() || !items.some((i) => i.kind === 'image')}
              onClick={() => void save()}
            >
              {selected ? '用当前参考图更新卡片' : '将当前参考图存为卡片'}
            </button>
            {error && <p role="alert">{error}</p>}
          </div>
        </Modal>
      )}
    </>
  )
}
