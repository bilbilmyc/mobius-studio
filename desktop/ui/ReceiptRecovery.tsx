import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { JobView } from '../shared'

interface Receipt {
  number: string
  model: string
  created: string
  status: string
  hasResult: boolean
}
export function ReceiptRecovery({ job }: { job: JobView }) {
  const [number, setNumber] = useState(''),
    [receipt, setReceipt] = useState<Receipt>()
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  async function check(confirm: boolean) {
    setBusy(true)
    setError('')
    try {
      if (confirm) await invoke('attach_receipt', { id: job.id, number })
      else setReceipt(await invoke<Receipt>('check_receipt', { id: job.id, number }))
    } catch (e) {
      setError(String(e))
      setReceipt(undefined)
    } finally {
      setBusy(false)
    }
  }
  return (
    <fieldset>
      <legend>找回官网任务</legend>
      <label>
        官网任务号
        <input
          inputMode="numeric"
          value={number}
          disabled={busy}
          onChange={(e) => {
            setNumber(e.target.value)
            setReceipt(undefined)
          }}
        />
      </label>
      <button disabled={busy || !number.trim()} onClick={() => void check(false)}>
        查询账户记录
      </button>
      {receipt && (
        <div>
          <p>
            本地提交于 {new Date(job.created).toLocaleString()} · {job.model}
          </p>
          <p>
            官网任务 {receipt.number} · {receipt.created} · {receipt.model || '官网未注明模板'} ·{' '}
            {receipt.status}
            {receipt.hasResult && ' · 已有结果'}
          </p>
          <button disabled={busy} onClick={() => void check(true)}>
            确认关联并取回
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  )
}
