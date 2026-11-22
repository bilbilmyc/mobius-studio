import { useState } from 'react'
import type { Scene, Script } from '../shared'
import { ExpandableText, Modal } from './Editor'

const longFields = { action: '画面与动作', dialogue: '台词或旁白', imagePrompt: '图片提示词', videoPrompt: '视频提示词' }
type LongField = keyof typeof longFields
type Field = 'heading' | LongField
const newId = () => crypto.randomUUID().replaceAll('-', '')
const blank = (): Scene => ({ id: newId(), heading: '', action: '', dialogue: '', imagePrompt: '', videoPrompt: '' })
const marker = /^(?:(?:第\s*)?[零〇一二两三四五六七八九十百\d]+\s*镜(?:头)?|(?:分镜|镜头|shot)\s*[零〇一二两三四五六七八九十百\d]+|\d+[.．、)）])[\s：:、.．\-—]*/i
const fieldNames: Record<string, Field> = {
  场景: 'heading', 标题: 'heading', 画面: 'action', 动作: 'action', 画面与动作: 'action',
  台词: 'dialogue', 旁白: 'dialogue', 台词或旁白: 'dialogue', 图片提示词: 'imagePrompt', 生图提示词: 'imagePrompt',
  视频提示词: 'videoPrompt', 运镜提示词: 'videoPrompt',
}
function parseScene(block: string[]): Scene {
  const scene = blank()
  let active: Field | undefined
  for (const line of block) {
    const match = line.match(/^([^:：]{1,10})[:：]\s*(.*)$/)
    if (match && fieldNames[match[1]]) {
      active = fieldNames[match[1]]
      scene[active] = [scene[active], match[2]].filter(Boolean).join('\n')
    } else if (!active && !scene.heading) scene.heading = line
    else {
      active ??= 'action'
      scene[active] = [scene[active], line].filter(Boolean).join('\n')
    }
  }
  scene.action ||= scene.heading || scene.imagePrompt || scene.videoPrompt || scene.dialogue
  scene.heading ||= scene.action.split('\n')[0].slice(0, 80)
  scene.imagePrompt ||= scene.action
  scene.videoPrompt ||= scene.action
  return scene
}

function parseShots(source: string): Scene[] {
  const lines = source.trim().split(/\r?\n/).map(s => s.trim())
  const numbered = lines.some(s => marker.test(s))
  const paragraphs = lines.includes('')
  const structured = lines.some(s => Object.keys(fieldNames).some(k => s.startsWith(k + '：') || s.startsWith(k + ':')))
  const blocks: string[][] = []
  let block: string[] = []
  function finish() { if (block.length) blocks.push(block); block = [] }
  for (const line of lines) {
    if (numbered && marker.test(line)) {
      finish()
      const title = line.replace(marker, '').trim()
      if (title) block.push(title)
    } else if (!line) { if (!numbered) finish() }
    else {
      block.push(line)
      if (!numbered && !paragraphs && !structured) finish()
    }
  }
  finish()
  return blocks.map(parseScene)
}

export function ScriptEditor({ initial, close, saved, beforeSave }: {
  initial?: Script; close: () => void; saved: (s: Script) => void; beforeSave: () => Promise<void>
}) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [scenes, setScenes] = useState(initial?.scenes ?? [])
  const [paste, setPaste] = useState(''), [pasteOpen, showPaste] = useState(!initial)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  function move(from: number, to: number) {
    if (from < 0 || to < 0 || from === to || to >= scenes.length) return
    const next = [...scenes]
    next.splice(to, 0, ...next.splice(from, 1)); setScenes(next)
  }
  function insert(at: number, scene: Scene) {
    setScenes(all => [...all.slice(0, at), scene, ...all.slice(at)])
  }
  function changeField(id: string, field: Field, value: string) {
    setScenes(all => all.map(scene => scene.id === id ? { ...scene, [field]: value } : scene))
  }
  async function save() {
    const all = [...scenes, ...parseShots(paste)]
    if (!all.length) { setError('请填写分镜正文或添加一镜。'); return }
    const story = { title: title.trim(), scenes: all.map((s, i) => ({ ...s, heading: s.heading.trim() || '镜头 ' + (i + 1),
      imagePrompt: s.imagePrompt.trim() || s.action, videoPrompt: s.videoPrompt.trim() || s.action })) }
    setError(''); setBusy(true)
    try {
      await beforeSave()
      saved(initial ? await window.studio.editScript(initial.id, story) : await window.studio.createScript(story))
    } catch (e) { setBusy(false); setError(String(e)) }
  }
  return <Modal wide title={initial ? '编辑剧本' : '手工分镜'} close={() => { if (!busy) close() }}>
    <form onSubmit={e => { e.preventDefault(); void save() }}>
      <div className="dialog-body fields shot-editor"><label>剧本标题<input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label>
        {pasteOpen ? <div className="paste-shots"><ExpandableText label="分镜正文" value={paste} change={setPaste}
          placeholder={'镜头 1 雨中的街口\n镜头 2 清晨的站台'} />
          <small>每行一镜。多行描述可用“镜头 1”“镜头 2”分段，也可填写场景、画面、台词和提示词。</small>
          <button type="button" disabled={!paste.trim()} onClick={() => {
            const parsed = parseShots(paste)
            if (!parsed.length) { setError('请在镜头编号后填写内容。'); return }
            setScenes(old => [...old, ...parsed]); setPaste(''); showPaste(false); setError('')
          }}>拆分并预览</button></div> : <button type="button" onClick={() => showPaste(true)}>续写或粘贴分镜</button>}
        {scenes.map((scene, index) => <fieldset key={scene.id}
          onDragOver={e => { if (e.dataTransfer.types.includes('application/x-mobius-scene')) e.preventDefault() }}
          onDrop={e => { const id = e.dataTransfer.getData('application/x-mobius-scene'); if (id) { e.preventDefault(); move(scenes.findIndex(s => s.id === id), index) } }}>
          <legend>分镜 {index + 1}</legend>
          <div className="shot-editor-actions">
            <span draggable title="拖动调整镜序" onDragStart={e => e.dataTransfer.setData('application/x-mobius-scene', scene.id)}>⠿</span>
            <button type="button" disabled={!index} onClick={() => move(index, index - 1)}>上移</button>
            <button type="button" disabled={index === scenes.length - 1} onClick={() => move(index, index + 1)}>下移</button>
            <button type="button" onClick={() => insert(index + 1, blank())}>插入一镜</button>
            <button type="button" onClick={() => insert(index + 1, { ...scene, id: newId() })}>复制</button>
            <button type="button" onClick={() => setScenes(all => all.filter(s => s.id !== scene.id))}>移除</button>
          </div>
          <label>场景<textarea rows={1} maxLength={12000} value={scene.heading}
            onChange={e => changeField(scene.id, 'heading', e.target.value)} /></label>
          {(Object.keys(longFields) as LongField[]).map(field => <ExpandableText key={field} label={longFields[field]}
            rows={2} required={field === 'action'} maxLength={12000} value={scene[field]}
            placeholder={field === 'imagePrompt' || field === 'videoPrompt' ? '默认使用画面与动作' : undefined}
            change={value => changeField(scene.id, field, value)} />)}
        </fieldset>)}
        <button type="button" onClick={() => insert(scenes.length, blank())}>添加分镜</button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      <footer className="modal-actions"><button type="button" disabled={busy} onClick={close}>取消</button>
        <button className="primary" disabled={busy}>保存剧本</button></footer>
    </form>
  </Modal>
}
