import type { Value } from '../shared'

export function ComfyControls({
  config,
  change,
  imageInput,
}: {
  config: Record<string, Value>
  change: (patch: Record<string, Value>) => void
  imageInput: boolean
}) {
  return (
    <details className="comfy-controls">
      <summary>采样参数</summary>
      <div className="two">
        <label>
          采样步数
          <input
            type="number"
            min={1}
            max={150}
            value={String(config.steps ?? 20)}
            onChange={(e) => change({ steps: Number(e.target.value) })}
          />
        </label>
        <label>
          引导强度 CFG
          <input
            type="number"
            min={0}
            max={30}
            step="0.1"
            value={String(config.cfg ?? 7)}
            onChange={(e) => change({ cfg: Number(e.target.value) })}
          />
        </label>
      </div>
      <label>
        随机种子（-1 为随机）
        <input
          type="number"
          min={-1}
          max={Number.MAX_SAFE_INTEGER}
          value={String(config.seed ?? -1)}
          onChange={(e) => change({ seed: Number(e.target.value) })}
        />
      </label>
      {imageInput && (
        <label>
          重绘强度
          <input
            type="number"
            min={0}
            max={1}
            step="0.01"
            value={String(config.denoise ?? 0.65)}
            onChange={(e) => change({ denoise: Number(e.target.value) })}
          />
        </label>
      )}
      <label>
        反向提示词
        <textarea
          rows={2}
          value={String(config.negative ?? '')}
          onChange={(e) => change({ negative: e.target.value })}
        />
      </label>
    </details>
  )
}
