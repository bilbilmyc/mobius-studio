import { useEffect, useState } from 'react'

export function RuntimeSettings() {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof window.studio.runtimeInfo>>>()
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    window.studio.runtimeInfo().then(value => { if (current) setInfo(value) })
      .catch(e => { if (current) setError(String(e)) })
    return () => { current = false }
  }, [])
  function run(action: () => Promise<void>) {
    setError('')
    void action().catch(e => setError(String(e)))
  }
  return <>
    <div className="preference-row"><div><h3>运行日志</h3>
      <p>按报错时间查看启动、任务和界面错误。上一次运行的记录也保存在这里。</p>
      {info && <code className="runtime-path">{info.logFile}</code>}</div>
      <button onClick={() => run(window.studio.openLogFolder)}>打开日志目录</button></div>
    <div className="preference-row"><div><h3>后台运行</h3>
      <p>{info ? info.tray ? '关闭主窗口会收起到系统托盘，任务继续运行。点击托盘图标可回到工作台。'
        : '关闭主窗口会最小化，任务继续运行。可从任务栏恢复窗口。' : '关闭主窗口后，任务继续运行。'}</p></div>
      <button onClick={() => run(window.studio.requestQuit)}>退出应用</button></div>
    {error && <p role="alert" className="form-error">{error}</p>}
  </>
}
