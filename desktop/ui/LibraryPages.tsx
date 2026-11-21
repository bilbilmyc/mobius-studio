export function paginate<T>(items: T[], requested: number, perPage = 60) {
  const pages = Math.max(1, Math.ceil(items.length / perPage))
  const page = Math.max(1, Math.min(requested, pages))
  return { page, pages, items: items.slice((page - 1) * perPage, page * perPage) }
}

export function PageControls({
  page,
  pages,
  label,
  change,
}: {
  page: number
  pages: number
  label: string
  change: (page: number) => void
}) {
  if (pages < 2) return null
  return (
    <nav className="library-pages" aria-label={label}>
      <button type="button" disabled={page === 1} onClick={() => change(page - 1)}>
        上一页
      </button>
      <select aria-label="选择页码" value={page} onChange={(e) => change(Number(e.target.value))}>
        {Array.from({ length: pages }, (_, i) => (
          <option value={i + 1} key={i + 1}>
            第 {i + 1} / {pages} 页
          </option>
        ))}
      </select>
      <button type="button" disabled={page === pages} onClick={() => change(page + 1)}>
        下一页
      </button>
    </nav>
  )
}
