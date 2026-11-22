import { useId, useState } from 'react'
import { invoke } from './ipc'
export interface LibraryMark {
  favorite: boolean
  archived: boolean
  tags: string[]
}
export const unmarked: LibraryMark = { favorite: false, archived: false, tags: [] }
export function LibraryMarks({
  id,
  mark,
  disabled,
  changed,
}: {
  id: string
  mark: LibraryMark
  disabled: boolean
  changed: (v: LibraryMark) => void
}) {
  const fieldId = useId()
  const [draft, setDraft] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const tags = draft ?? mark.tags.join('，')
  async function save(next: LibraryMark, savedTags = false) {
    setBusy(true)
    try {
      await invoke('mark_work', { id, mark: next })
      changed(next)
      if (savedTags) setDraft(null)
      setError('')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="work-marks">
      <div className="work-mark-actions">
        <button
          disabled={disabled || busy}
          aria-pressed={mark.favorite}
          onClick={() => void save({ ...mark, favorite: !mark.favorite })}
        >
          {mark.favorite ? '取消收藏' : '收藏作品'}
        </button>
        <button
          disabled={disabled || busy}
          onClick={() => void save({ ...mark, archived: !mark.archived })}
        >
          {mark.archived ? '移出归档' : '归档作品'}
        </button>
      </div>
      <form
        className="work-tags"
        onSubmit={(e) => {
          e.preventDefault()
          if (!disabled && !busy && draft !== null) {
            const values = tags
              .split(/[,，]/)
              .map((tag) => tag.trim())
              .filter(Boolean)
            void save({ ...mark, tags: [...new Set(values)] }, true)
          }
        }}
      >
        <label htmlFor={fieldId}>作品标签</label>
        <div className="work-tag-entry">
          <input
            id={fieldId}
            disabled={disabled || busy}
            value={tags}
            placeholder="用逗号分隔标签"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={disabled || busy || tags === mark.tags.join('，')}>
            保存标签
          </button>
        </div>
      </form>
      {error && <span role="alert">{error}</span>}
    </div>
  )
}
