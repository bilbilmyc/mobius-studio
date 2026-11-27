import { useState } from 'react'
import { version } from '../../package.json'
import { invoke } from './ipc'

interface UpdateInfo {
  latest: string
  available: boolean
  package: string | null
  install: boolean
}

export function UpdateSettings() {
  const [info, setInfo] = useState<UpdateInfo>()
  const [busy, setBusy] = useState<'check' | 'download' | 'install' | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  async function check() {
    setBusy('check'); setError(''); setMessage(''); setInfo(undefined); setReady(false)
    try { setInfo(await invoke<UpdateInfo>('check_app_update')) }
    catch (e) { setError(String(e)) }
    finally { setBusy(null) }
  }
  async function download(update: UpdateInfo) {
    setBusy('download'); setError(''); setMessage('')
    try {
      await invoke('get_app_update', { version: update.latest })
      setReady(update.install)
      setMessage(update.install ? '更新包已通过 SHA-256 校验，可以安装。' : '更新包已通过校验并打开。')
    } catch (e) { setError(String(e)) }
    finally { setBusy(null) }
  }
  async function install(update: UpdateInfo) {
    setBusy('install'); setError('')
    try { await invoke('install_app_update', { version: update.latest }) }
    catch (e) { setError(String(e)) }
    finally { setBusy(null) }
  }
  function instructions(update: UpdateInfo) {
    if (!update.package) return '本版本还没有适用于本机的更新包。'
    if (update.install) return ready ? '退出时会保存分镜草稿。自由创作中尚未提交的提示词和参考图选择会清空。' : '可以先下载，完成手头的创作后再安装。'
    if (/\.(zip|tar\.gz)$/.test(update.package)) return '下载后会打开文件位置。退出工作台后，解压到原便携目录即可升级。'
    return '下载并校验后，将打开适用于本机的安装包。'
  }
  return <>
    <div className="preference-row">
      <div><h3>莫比环</h3><p>当前版本 {version}</p></div>
      <button disabled={!!busy} onClick={() => void check()}>{busy === 'check' ? '正在检查…' : '检查更新'}</button>
    </div>
    {info && <div className="preference-row">
      <div><h3 role="status">{info.available ? '发现新版本 ' + info.latest : '已是最新版本'}</h3>
        {info.available && <p>{instructions(info)}</p>}
      </div>
      {info.available && info.package && <button className="primary" disabled={!!busy} onClick={() => void (ready ? install(info) : download(info))}>
        {busy === 'download' ? '正在下载并校验…' : ready ? '退出并安装' : '下载更新包'}
      </button>}
    </div>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    <button className="link" onClick={() => void invoke('open_app_releases').catch(e => setError(String(e)))}>查看发布记录 ↗</button>
  </>
}
