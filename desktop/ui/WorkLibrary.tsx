import { invoke } from '@tauri-apps/api/core'
import { LibraryMarks, unmarked, type LibraryMark } from './LibraryMarks'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { jobStatusGroup, siteTemplate, type Integrations, type JobStatusGroup, type JobView, type MediaKind } from '../shared'
import { BatchExport } from './BatchExport'
import { CloudSave } from './CloudSave'
import { paginate, PageControls } from './LibraryPages'
import { WorkCard } from './WorkCard'

interface LibraryView {
  search: string
  kind: MediaKind | 'all'
  status: JobStatusGroup | 'all'
  page: number
}
export const defaultLibraryView: LibraryView = { search: '', kind: 'all', status: 'all', page: 1 }

interface Props {
  jobs: JobView[]
  view: LibraryView
  setView: (view: LibraryView) => void
  selectedId: string
  select: (id: string) => void
  inspect: (job: JobView) => void
  makeVideo: (job: JobView) => Promise<void>
  attempt: (fn: () => Promise<unknown>) => Promise<void>
  settings?: Integrations
  configureStorage: () => void
  report: (message: string) => void
}

export function WorkLibrary({
  jobs,
  view,
  setView,
  selectedId,
  select,
  inspect,
  makeVideo,
  attempt,
  settings,
  configureStorage,
  report,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const [batchOpen, setBatchOpen] = useState(false)
  const [collection,setCollection] = useState('current'), [marks,setMarks] = useState<Record<string,LibraryMark>>({})
  useEffect(()=>{void invoke<Record<string,LibraryMark>>('library_marks').then(setMarks).catch(e=>report(String(e)))},[report])
  const { search, kind, status } = view
  const filtered = useMemo(() => {
    const words = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    return jobs.filter((j) => {
      const mark=marks[j.id] ?? unmarked
      if (collection==='archived' ? !mark.archived : mark.archived) return false
      if (collection==='favorite' && !mark.favorite) return false
      if (kind !== 'all' && j.kind !== kind) return false
      if (status !== 'all' && jobStatusGroup(j.status) !== status) return false
      if (!words.length) return true
      const fields = [
        ...mark.tags,
        j.prompt,
        j.model,
        siteTemplate(j.model)?.Name,
        j.profileName,
        j.id,
        j.remoteId,
        j.shot?.label,
      ]
        .join(' ')
        .toLocaleLowerCase()
      return words.every((word) => fields.includes(word))
    })
  }, [jobs, search, kind, status, marks, collection])
  const { items, page, pages } = paginate(filtered, view.page)
  const selected = items.find((j) => j.id === selectedId)
  const matching = Boolean(search.trim() || kind !== 'all' || status !== 'all')
  function change(patch: Partial<LibraryView>) {
    setView({ ...view, page: 1, ...patch })
    select('')
  }
  useLayoutEffect(() => {
    scroller.current?.scrollTo(0, 0)
  }, [page, search, kind, status])
  useLayoutEffect(() => {
    if (page !== view.page) setView({ ...view, page })
  }, [page, view, setView])

  return (
    <section className="library-page" aria-label="作品库">
      {selected && <LibraryMarks key={selected.id} id={selected.id} mark={marks[selected.id] ?? unmarked} changed={m=>setMarks(old=>({...old,[selected.id]:m}))}/>}
      <div className="section-bar">
        <small>
          {filtered.length} 条{matching ? '匹配作品' : '本地任务'}
        </small>
        <select aria-label="作品收藏与归档" value={collection} onChange={e=>{setCollection(e.target.value);change({})}}>
          <option value="current">当前作品</option><option value="favorite">已收藏</option><option value="archived">已归档</option></select>
        <input
          type="search"
          className="library-search"
          aria-label="搜索作品"
          placeholder="搜索提示词、模型或分镜"
          value={search}
          onChange={(e) => change({ search: e.target.value })}
        />
        <select
          aria-label="筛选作品"
          value={kind}
          onChange={(e) => change({ kind: e.target.value as LibraryView['kind'] })}
        >
          <option value="all">全部作品</option>
          <option value="image">仅图片</option>
          <option value="video">仅视频</option>
        </select>
        <select
          aria-label="任务状态"
          value={status}
          onChange={(e) => change({ status: e.target.value as LibraryView['status'] })}
        >
          <option value="all">全部状态</option>
          <option value="active">进行中</option>
          <option value="attention">待处理</option>
          <option value="done">已完成</option>
        </select>
        <button disabled={!selected} onClick={() => selected && inspect(selected)}>
          查看所选任务
        </button>
        <button
          disabled={!filtered.some((j) => j.file && j.kind === 'image' && j.status === 'done')}
          onClick={() => setBatchOpen(true)}
        >
          批量导出
        </button>
        {selected && (
          <CloudSave
            job={selected}
            settings={settings}
            configure={configureStorage}
            report={report}
          />
        )}
      </div>
      <div className="page-body" ref={scroller}>
        <div className="gallery">
          {items.map((j) => (
            <WorkCard
              key={j.id}
              job={j}
              performance={settings?.performance ?? 'auto'}
              selected={selectedId === j.id}
              choose={() => select(j.id)}
              inspect={() => inspect(j)}
              makeVideo={() => void attempt(() => makeVideo(j))}
              copyImage={(link) =>
                void attempt(async () => {
                  await window.studio.copyImage(j.id, link)
                  report(link ? '已复制本地图片链接。' : '已复制图像。')
                })
              }
              saveOriginal={() =>
                void attempt(async () => {
                  const path = await window.studio.exportFile(j.id, null, true)
                  if (path) report('原文件已另存到 ' + path)
                })
              }
            />
          ))}
        </div>
        {!items.length && (
          <div className="empty">
            {matching ? (
              <>
                <span>没有匹配的作品</span>
                <button onClick={() => change(defaultLibraryView)}>清除筛选</button>
              </>
            ) : (
              '还没有这类作品'
            )}
          </div>
        )}
      </div>
      <PageControls
        page={page}
        pages={pages}
        label="作品库分页"
        change={(page) => change({ page })}
      />
      {batchOpen && (
        <BatchExport
          jobs={filtered}
          mode={settings?.performance ?? 'auto'}
          close={() => setBatchOpen(false)}
        />
      )}
    </section>
  )
}
