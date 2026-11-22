import { useEffect, useState } from 'react'
import { invoke } from './ipc'
type Tools = { ffmpeg: string | null; ffprobe: string | null }
export function MediaToolSettings() {
  const [tools, setTools] = useState<Tools>(),
    [error, say] = useState('')
  useEffect(() => {
    void invoke<Tools>('media_tools')
      .then(setTools)
      .catch((e) => say(String(e)))
  }, [])
  return (
    <div className="preference-row">
      <div>
        <h3>整片合成工具</h3>
        <p>
          {tools?.ffmpeg && tools.ffprobe
            ? '已找到 FFmpeg 与 ffprobe。'
            : '合成 MP4 需要 FFmpeg 和 ffprobe。可选择它们所在的目录。'}
        </p>
        {tools?.ffmpeg && <small>{tools.ffmpeg}</small>}
        {error && <p role="alert">{error}</p>}
      </div>
      <button
        onClick={() =>
          void invoke<Tools>('choose_media_tools')
            .then((t) => {
              setTools(t)
              say('')
            })
            .catch((e) => say(String(e)))
        }
      >
        选择工具目录
      </button>
    </div>
  )
}
