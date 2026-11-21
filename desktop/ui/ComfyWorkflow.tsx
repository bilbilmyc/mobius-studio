import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Modal } from './Editor'
type Nodes = Record<string, { class_type: string; inputs: Record<string, unknown> }>
interface Graph {
  graph: Nodes
  promptNode: string
  promptField: string
  imageNode: string | null
  imageField: string
  outputNode: string
}
const empty: Graph = {
  graph: {},
  promptNode: '',
  promptField: 'text',
  imageNode: null,
  imageField: 'image',
  outputNode: '',
}
export function ComfyWorkflow({
  profileId,
  model,
  changed,
}: {
  profileId: string
  model: string
  changed: (enabled: boolean) => void
}) {
  const [open, show] = useState(false),
    [g, set] = useState<Graph>(empty),
    [message, say] = useState(''),
    [busy, lock] = useState(false)
  useEffect(() => {
    let alive = true
    void invoke<Graph | null>('get_graph', { profileId, model })
      .then((v) => {
        if (alive) {
          set(v ?? empty)
          changed(!!v)
        }
      })
      .catch((e) => say(String(e)))
    return () => {
      alive = false
    }
  }, [profileId, model])
  const options = Object.entries(g.graph).map(([id, node]) => (
    <option key={id} value={id}>
      {id} · {node.class_type}
    </option>
  ))
  async function save(graph: Graph | null) {
    lock(true)
    try {
      await invoke('configure_graph', { profileId, model, graph })
      changed(!!graph)
      if (!graph) set(empty)
      say(graph ? '已核对服务端节点和模型，生成将使用这个工作流。' : '已恢复内置工作流。')
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
          show(true)
          say('')
          void invoke<Graph | null>('get_graph', { profileId, model })
            .then((v) => set(v ?? empty))
            .catch((e) => say(String(e)))
        }}
      >
        ComfyUI 工作流
      </button>
      {open && (
        <Modal title="ComfyUI 工作流" close={() => show(false)}>
          <div className="project-tools">
            {Object.keys(g.graph).length > 0 && (
              <details>
                <summary>工作流节点与实际参数</summary>
                <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(g.graph, null, 2)}</pre>
              </details>
            )}
            <label>
              导入 API 工作流 JSON
              <input
                type="file"
                accept=".json"
                onChange={async (e) => {
                  try {
                    const f = e.target.files?.[0]
                    if (!f) return
                    if (f.size > 2 * 1024 * 1024) throw Error('工作流超过 2 MiB。')
                    const body = JSON.parse(await f.text())
                    const nodes = body.prompt ?? body
                    if (
                      !Object.values(nodes).every((n) => n && typeof n === 'object' && 'class_type' in n)
                    )
                      throw Error('请导出 API 格式工作流。')
                    const find = (t: string) =>
                      Object.keys(nodes).find((k) => nodes[k].class_type === t) ?? ''
                    set({
                      ...empty,
                      graph: nodes,
                      promptNode: find('CLIPTextEncode'),
                      imageNode: find('LoadImage') || null,
                      outputNode: find('SaveImage'),
                    })
                    say('')
                  } catch (e) {
                    say(String(e))
                  }
                }}
              />
            </label>
            <label>
              提示词节点
              <select value={g.promptNode} onChange={(e) => set({ ...g, promptNode: e.target.value })}>
                <option value="">请选择</option>
                {options}
              </select>
            </label>
            <label>
              提示词字段
              <input
                value={g.promptField}
                onChange={(e) => set({ ...g, promptField: e.target.value })}
              />
            </label>
            <label>
              参考图节点
              <select
                value={g.imageNode ?? ''}
                onChange={(e) => set({ ...g, imageNode: e.target.value || null })}
              >
                <option value="">无参考图</option>
                {options}
              </select>
            </label>
            {g.imageNode && (
              <label>
                参考图字段
                <input
                  value={g.imageField}
                  onChange={(e) => set({ ...g, imageField: e.target.value })}
                />
              </label>
            )}
            <label>
              结果节点
              <select value={g.outputNode} onChange={(e) => set({ ...g, outputNode: e.target.value })}>
                <option value="">请选择</option>
                {options}
              </select>
            </label>
            <button disabled={busy || !g.promptNode || !g.outputNode} onClick={() => void save(g)}>
              检查节点与模型并使用
            </button>
            <button disabled={busy} onClick={() => void save(null)}>
              恢复内置工作流
            </button>
            {message && <p role="status">{message}</p>}
          </div>
        </Modal>
      )}
    </>
  )
}
