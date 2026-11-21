import { useEffect, useState } from 'react'
import type { PerformanceMode } from '../shared'
import { graphicsDevice } from './gpuExport'

const descriptions: Record<PerformanceMode, string> = {
  auto: '适量预读作品缩略图，使用原生高质量缩放。',
  eco: '只加载可见缩略图，减少等待动画，使用原生缩放。',
  performance: '提前加载相邻作品，使用 GPU 缩放导出图片。设备不可用时自动切换至 CPU。',
}
export function PerformanceSettings({
  mode,
  reload,
}: {
  mode: PerformanceMode
  reload: () => Promise<void>
}) {
  const [device, setDevice] = useState<ReturnType<typeof graphicsDevice>>()
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  useEffect(() => {
    setDevice(graphicsDevice())
  }, [])
  return (
    <div className="integration-form">
      <label>
        性能模式
        <select
          value={mode}
          disabled={busy}
          onChange={async (e) => {
            const value = e.target.value as PerformanceMode
            setBusy(true)
            setMessage('')
            try {
              await window.studio.savePerformance(value)
              await reload()
              setMessage('性能设置已保存。')
            } catch (err) {
              setMessage(String(err))
            } finally {
              setBusy(false)
            }
          }}
        >
          <option value="auto">自动</option>
          <option value="eco">省电</option>
          <option value="performance">高性能</option>
        </select>
      </label>
      <p>{descriptions[mode]}</p>
      <div className="preference-row">
        <div>
          <h3>本机图形设备</h3>
          <p className="device-name">{device?.label ?? '正在检测图形设备…'}</p>
          {device && <small>{device.available ? '硬件 WebGL 2 可用' : '使用 CPU 导出'}</small>}
        </div>
      </div>
      <span role="status">{message}</span>
    </div>
  )
}
