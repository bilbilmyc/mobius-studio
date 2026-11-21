import { useEffect, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { Modal } from './Editor'
import type { JobView, Picked, Slot } from '../shared'

export function frameOrder(items: Picked[]): Picked[] {
  return items
    .map((a, i) => ({
      ...a,
      role: a.role ?? (i === 0 ? 'first_frame' : 'last_frame'),
    }))
    .sort(
      (a, b) =>
        Number(a.role === 'last_frame') - Number(b.role === 'last_frame'),
    )
}
export function addAssets(
  old: Picked[],
  more: Picked[],
  slot: Slot,
  paired: boolean,
  role?: string,
) {
  if (!more.length) return old
  if (paired) {
    const existing = frameOrder(old)
    const names = role
      ? [role]
      : ['first_frame', 'last_frame'].filter(
          (r) => !existing.some((a) => a.role === r),
        )
    if (more.length > names.length) throw Error('首帧和尾帧各需要一张图片。')
    return frameOrder([
      ...existing.filter(
        (a) => !names.slice(0, more.length).includes(a.role ?? ''),
      ),
      ...more.map((a, i) => ({ ...a, role: names[i] })),
    ])
  }
  if (old.filter((a) => a.kind === slot.Kind).length + more.length > slot.Max)
    throw Error(slot.Label + '最多可添加 ' + slot.Max + ' 个文件。')
  return [...old, ...more]
}
function Thumbnail({ item }: { item: Picked }) {
  const [url, show] = useState('')
  useEffect(() => {
    let active = true
    show('')
    if (item.kind === 'image')
      void window.studio
        .preview(item)
        .then((p) => {
          if (active && p) show(convertFileSrc(p))
        })
        .catch(() => {})
    return () => {
      active = false
    }
  }, [item.token])
  return url ? (
    <img src={url} className="asset-thumb" alt="" loading="lazy" />
  ) : null
}
export function Assets({
  slot,
  items,
  paired,
  allowLink,
  jobs,
  add,
  change,
  report,
}: {
  slot: Slot
  items: Picked[]
  paired: boolean
  allowLink: boolean
  jobs: JobView[]
  add: (more: Picked[], role?: string) => void
  change: (v: Picked[]) => void
  report: (m: string) => void
}) {
  const [box, setBox] = useState<{
      type: 'link' | 'library'
      role?: string
    } | null>(null),
    [link, setLink] = useState(''),
    [error, setError] = useState('')
  const group = paired
      ? frameOrder(items)
      : items.filter((a) => a.kind === slot.Kind),
    available = jobs.filter((j) => j.file && j.kind === 'image')
  const run = async (action: () => Promise<void>) => {
    try {
      await action()
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      if (box) setError(m)
      else report(m)
    }
  }
  function move(a: Picked, n: number) {
    const target = group[group.indexOf(a) + n],
      out = [...items],
      i = out.findIndex((x) => x.token === a.token),
      j = out.findIndex((x) => x.token === target.token)
    ;[out[i], out[j]] = [out[j], out[i]]
    change(out)
  }
  function open(type: 'link' | 'library', role?: string) {
    setBox({ type, role })
    setLink('')
    setError('')
  }
  function buttons(role?: string) {
    const full = !paired && group.length >= slot.Max
    return (
      <div className="asset-tools">
        <button
          disabled={full}
          aria-label={
            (role === 'first_frame'
              ? '首帧'
              : role === 'last_frame'
                ? '尾帧'
                : slot.Label) + '选择本地文件'
          }
          onClick={() =>
            void run(async () =>
              add(
                await window.studio.pick(slot.Kind, !paired && slot.Max > 1),
                role,
              ),
            )
          }
        >
          选择文件
        </button>
        {slot.Kind === 'image' && available.length > 0 && (
          <button disabled={full} onClick={() => open('library', role)}>
            作品库选图
          </button>
        )}
        {allowLink && (
          <button disabled={full} onClick={() => open('link', role)}>
            使用链接
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="slot" data-slot={slot.Kind}>
      <div className="label-row">
        <b>
          {slot.Label}
          {slot.Min > 0 ? '（必填）' : ''}
        </b>
        <small>
          {group.length}/{slot.Max}
        </small>
      </div>
      {paired ? (
        <>
          {['first_frame', 'last_frame'].map((role, i) => {
            const a = group.find((a) => a.role === role)
            return (
              <section className="frame-place" data-role={role} key={role}>
                <strong>{i ? '尾帧' : '首帧'}</strong>
                {a && (
                  <div className="file-row">
                    <Thumbnail item={a} />
                    <span>{a.name}</span>
                    <button
                      aria-label={'移除' + (i ? '尾帧' : '首帧')}
                      onClick={() => change(group.filter((x) => x !== a))}
                    >
                      ×
                    </button>
                  </div>
                )}
                {buttons(role)}
              </section>
            )
          })}
          {group.length === 2 && (
            <button
              className="link"
              onClick={() =>
                change(
                  frameOrder(
                    group.map((a) => ({
                      ...a,
                      role:
                        a.role === 'first_frame' ? 'last_frame' : 'first_frame',
                    })),
                  ),
                )
              }
            >
              交换首尾帧 ⇄
            </button>
          )}
        </>
      ) : (
        <>
          {buttons()}
          {group.map((a, i) => (
            <div className="file-row" key={a.token}>
              <Thumbnail item={a} />
              <span title={a.name}>
                {i + 1}. {a.name}
              </span>
              <button
                disabled={!i}
                aria-label="上移"
                onClick={() => move(a, -1)}
              >
                ↑
              </button>
              <button
                disabled={i === group.length - 1}
                aria-label="下移"
                onClick={() => move(a, 1)}
              >
                ↓
              </button>
              <button
                aria-label="移除素材"
                onClick={() => change(items.filter((x) => x.token !== a.token))}
              >
                ×
              </button>
            </div>
          ))}
        </>
      )}
      {box && (
        <Modal
          title={box.type === 'link' ? '添加素材链接' : '从作品库选择图片'}
          close={() => setBox(null)}
        >
          {box.type === 'link' ? (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void run(async () => {
                  add([await window.studio.link(slot.Kind, link)], box.role)
                  setBox(null)
                })
              }}
            >
              <label>
                HTTPS 素材地址
                <input
                  autoFocus
                  type="url"
                  required
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder="https://…"
                />
              </label>
              <footer className="modal-actions">
                <button className="primary">添加素材</button>
              </footer>
            </form>
          ) : (
            <div className="asset-library">
              {available.map((j) => (
                <button
                  key={j.id}
                  onClick={() =>
                    void run(async () => {
                      add([await window.studio.frame(j.id)], box.role)
                      setBox(null)
                    })
                  }
                >
                  <img alt="" src={convertFileSrc(j.mediaPath!)} />
                  <span>{j.prompt || j.model}</span>
                </button>
              ))}
            </div>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </Modal>
      )}
    </div>
  )
}
