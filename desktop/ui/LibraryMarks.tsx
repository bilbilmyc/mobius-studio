import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
export interface LibraryMark {
  favorite: boolean
  archived: boolean
  tags: string[]
}
export const unmarked: LibraryMark = { favorite: false, archived: false, tags: [] }
export function LibraryMarks({
  id,
  mark,
  changed,
}: {
  id: string
  mark: LibraryMark
  changed: (v: LibraryMark) => void
}) {
  const [tags, setTags] = useState(mark.tags.join('，')),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  async function save(next: LibraryMark) {
    setBusy(true)
    try {
      await invoke('mark_work', { id, mark: next })
      changed(next)
      setError('')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mark-tools">
      <button
        disabled={busy}
        aria-pressed={mark.favorite}
        onClick={() => void save({ ...mark, favorite: !mark.favorite })}
      >
        {mark.favorite ? '取消收藏' : '收藏作品'}
      </button>
      <button disabled={busy} onClick={() => void save({ ...mark, archived: !mark.archived })}>
        {mark.archived ? '移出归档' : '归档作品'}
      </button>
      <label>
        作品标签
        <input value={tags} placeholder="多个标签用逗号分开" onChange={(e) => setTags(e.target.value)} />
      </label>
      <button
        disabled={busy}
        onClick={() =>
          void save({
            ...mark,
            tags: [
              ...new Set(
                tags
                  .split(/[,，]/)
                  .map((t) => t.trim())
                  .filter(Boolean)
              ),
            ],
          })
        }
      >
        保存标签
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  )
}
