import { useCallback, useEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Composer, FreeDraft, MediaKind, Picked, Script, ShotDraft, ShotLink } from '../shared'
import { defaultTemplate, siteTemplate } from '../shared'

const empty = (): Composer => ({ service: '@site', models: {}, templates: {}, prompt: '', variants: {}, compare: '' })
const keyOf = (kind: MediaKind, shot?: ShotLink) => [kind, shot?.scriptId, shot?.sceneId].join('/')

function references(editor: Composer) {
  const picks = new Map<string, Picked>()
  for (const variant of Object.values(editor.variants)) {
    if (variant.mask) picks.set(variant.mask.token,variant.mask)
    for (const items of Object.values(variant.byMode))
      for (const pick of items) picks.set(pick.token, pick)
  }
  return [...picks.values()]
}

export function useShotDrafts(report: (s: string) => void) {
  const book = useRef(new Map<string, ShotDraft>())
  const free = useRef({ image: empty(), video: empty() })
  const dirty = useRef(new Map<string, ShotDraft | FreeDraft>())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const writing = useRef<Promise<void> | null>(null)
  const [bindings, bind] = useState<Partial<Record<MediaKind, ShotLink>>>({})
  const [ready, setReady] = useState(false), [, redraw] = useState(0)
  const [status, setStatus] = useState('')
  const [loadError, setLoadError] = useState('')

  function flush(): Promise<void> {
    clearTimeout(timer.current)
    if (writing.current) return writing.current
    if (!dirty.current.size) return Promise.resolve()
    setStatus('正在保存草稿…')
    writing.current = (async () => {
      while (dirty.current.size) {
        const [key, entry] = dirty.current.entries().next().value!
        const picks = references(entry.editor)
        if ('shot' in entry) await window.studio.saveShotDraft(entry, picks)
        else await window.studio.saveFreeDraft(entry, picks)
        if (dirty.current.get(key) === entry) dirty.current.delete(key)
      }
      setStatus('草稿已保存')
    })().catch(e => {
      setStatus('草稿保存失败')
      report(String(e))
      throw e
    }).finally(() => { writing.current = null })
    return writing.current
  }
  const loadDrafts = useCallback(async () => {
    try {
      const [shots, drafts] = await Promise.all([window.studio.shotDrafts(), window.studio.freeDrafts()])
      for (const entry of shots) book.current.set(keyOf(entry.kind, entry.shot), entry)
      for (const entry of drafts) free.current[entry.kind] = entry.editor
      setLoadError('')
      setReady(true)
    } catch (e) {
      setLoadError('读取创作草稿失败。' + String(e))
    }
  }, [])
  useEffect(() => {
    void loadDrafts()
    const unsubscribe = getCurrentWindow().onCloseRequested(async event => {
      // The native window handles closing to the tray. Only an explicit quit can exit.
      event.preventDefault()
      let saved = false
      try { await flush(); saved = true } catch { /* flush already reports the error */ }
      try { await window.studio.finishWindowClose(saved) } catch (e) { report(String(e)) }
    })
    return () => { clearTimeout(timer.current); void unsubscribe.then(off => off()) }
  }, [report, loadDrafts])

  function get(kind: MediaKind, shot?: ShotLink): Composer {
    return shot ? book.current.get(keyOf(kind, shot))?.editor ?? empty() : free.current[kind]
  }
  function change(kind: MediaKind, shot: ShotLink | undefined, edit: (editor: Composer) => Composer, background = false) {
    const key = keyOf(kind, shot)
    const saved = shot && book.current.get(key)
    if (!ready || (shot && background && !saved)) return
    const previous = get(kind, shot)
    const editor = edit(previous)
    if (previous === editor) return
    if (shot) {
      const entry = { kind, shot: saved?.shot ?? shot, editor, updated: background && saved ? saved.updated : Date.now() }
      book.current.set(key, entry)
      dirty.current.set(key, entry)
      void flush().catch(() => {})
    } else {
      free.current[kind] = editor
      dirty.current.set(key, { kind, editor, updated: Date.now() })
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush().catch(() => {}), 250)
    }
    redraw(n => n + 1)
  }
  function select(kind: MediaKind, shot?: ShotLink) {
    bind(old => ({ ...old, [kind]: shot }))
  }
  function open(kind: MediaKind, shot: ShotLink, prompt: string) {
    if (!ready) return
    const seed = get(kind, bindings[kind])
    const saved = book.current.get(keyOf(kind, shot))
    let editor = saved?.editor
    if (!editor) {
      const template = siteTemplate(seed.templates[seed.service] ?? '')
      const templates = template && !template.Text
        ? { ...seed.templates, [seed.service]: defaultTemplate(kind).Key } : seed.templates
      editor = { ...empty(), service: seed.service, models: seed.models, templates, prompt }
    } else if (editor.prompt === editor.scriptPrompt) editor = { ...editor, prompt }
    change(kind, shot, () => ({ ...editor!, scriptPrompt: prompt }))
    select(kind, shot)
  }
  function syncScript(script: Script) {
    const links = new Map(script.scenes.map((s, i) => [s.id, { scriptId: script.id, sceneId: s.id, label: script.title + ' · 第 ' + (i + 1) + ' 镜' }]))
    for (const [key, entry] of book.current) {
      if (entry.shot.scriptId !== script.id) continue
      const link = links.get(entry.shot.sceneId)
      if (link) book.current.set(key, { ...entry, shot: link })
      else { book.current.delete(key); dirty.current.delete(key) }
    }
    bind(old => Object.fromEntries(Object.entries(old).map(([kind, shot]) =>
      [kind, shot?.scriptId === script.id ? links.get(shot.sceneId) : shot])))
  }
  let latest: ShotDraft | undefined
  for (const entry of book.current.values())
    if (!latest || latest.updated < entry.updated) latest = entry
  async function reload() {await flush();const entries=await window.studio.shotDrafts();for(const entry of entries)book.current.set(keyOf(entry.kind,entry.shot),entry);redraw(n=>n+1)}
  return { get, change, select, open, syncScript, flush, reload, ready, loadDrafts, loadError, bindings, latest, status }
}
