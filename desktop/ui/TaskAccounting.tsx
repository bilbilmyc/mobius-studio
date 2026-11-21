import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { JobView } from '../shared'
interface Charge {
  amount: number
  unit: string
  receipt: string
}
export function TaskAccounting({ job }: { job: JobView }) {
  const [amount, setAmount] = useState(''),
    [unit, setUnit] = useState('CNY'),
    [receipt, setReceipt] = useState(''),
    [message, say] = useState('')
  async function load() {
    const c = await invoke<Charge | null>('get_charge', { id: job.id })
    setAmount(c ? String(c.amount) : '')
    setUnit(c?.unit ?? 'CNY')
    setReceipt(c?.receipt ?? '')
  }
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open) void load().catch((e) => say(String(e)))
      }}
    >
      <summary>预估与账单实扣</summary>
      <div className="project-tools">
        <p>{job.estimatedCny == null ? '预估价格未知' : '预估 ¥' + job.estimatedCny.toFixed(2)}</p>
        <label>
          账单实扣
          <input
            type="number"
            min="0"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          账单单位
          <select value={unit} onChange={(e) => setUnit(e.target.value)}>
            {['CNY', 'USD', '积分'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label>
          账单凭据编号
          <input value={receipt} onChange={(e) => setReceipt(e.target.value)} />
        </label>
        <button
          disabled={!amount || !receipt.trim()}
          onClick={() =>
            void invoke('record_charge', {
              id: job.id,
              charge: { amount: Number(amount), unit, receipt },
            })
              .then(() => say('已按凭据保存实扣。'))
              .catch((e) => say(String(e)))
          }
        >
          记录实扣
        </button>
        {message && <p role="status">{message}</p>}
      </div>
    </details>
  )
}
