import { useEffect, useState } from 'react'
import { convertFileSrc, invoke } from './ipc'
import { type JobView, statusLabels } from '../shared'
import { Modal } from './Editor'
export function CandidateGallery({
  ids,
  jobs,
  inspect,
}: {
  ids: string[]
  jobs: JobView[]
  inspect: (j: JobView) => void
}) {
  const [open, show] = useState(false),
    [selected, select] = useState(''),
    [error, say] = useState('')
  useEffect(() => {
    if (open)
      void invoke<string | null>('candidate_choice', { id: ids[0] })
        .then((v) => select(v ?? ''))
        .catch((e) => say(String(e)))
  }, [open, ids[0]])
  return (
    <>
      <button onClick={() => show(true)}>对照 {ids.length} 张候选</button>
      {open && (
        <Modal wide title="同模型候选" close={() => show(false)}>
          <div className="project-tools candidate-grid">
            {ids.map((id, i) => {
              const j = jobs.find((j) => j.id === id)
              return (
                <section key={id}>
                  <h3>候选 {i + 1}</h3>
                  {j?.file && <img alt={'候选 ' + (i + 1)} src={convertFileSrc(j.mediaPath!)} />}
                  <p>{j ? (statusLabels[j.status] ?? j.status) : '等待结果'}</p>
                  {j?.file && (
                    <>
                      <button
                        aria-pressed={selected === id}
                        onClick={() =>
                          void invoke('choose_candidate', { id })
                            .then(() => select(id))
                            .catch((e) => say(String(e)))
                        }
                      >
                        {selected === id ? '已定稿' : '选为定稿'}
                      </button>
                      <button
                        onClick={() => {
                          show(false)
                          inspect(j)
                        }}
                      >
                        打开作品
                      </button>
                    </>
                  )}
                </section>
              )
            })}
            {error && <p role="alert">{error}</p>}
          </div>
        </Modal>
      )}
    </>
  )
}
