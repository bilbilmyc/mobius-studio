import type { ScriptRun } from '../shared'
import { WaitTime } from './JobPreviewState'
import { ServiceError } from './UsageHelp'
import { useVisibleTime } from './taskHelp'
import './script-run.css'

function FilmStrip() {
  return <div className="script-light-table" aria-hidden="true">
    <div className="script-film">
      <div className="script-film-belt">
        {[0, 1].map(copy => <div className="script-film-loop" key={copy}>
          <i className="film-wide" /><i className="film-detail" /><i className="film-turn" />
        </div>)}
      </div>
    </div>
    <div className="film-gate"><i /><i /><i /><i /></div>
  </div>
}

export function ScriptRunView({ run, active, background, edit, configure, hasDraft }: {
  run: ScriptRun; active: boolean; background: () => void; edit: () => void; configure: () => void; hasDraft: boolean
}) {
  const writing = run.status === 'writing'
  const now = useVisibleTime(active && writing, 1000)
  return <section className={'script-run' + (writing ? ' is-writing' : '')} aria-labelledby="script-run-title">
    <header className="script-run-header">
      <div>
        <div role="status"><h2 id="script-run-title">{writing ? '正在生成剧本' : run.status === 'interrupted' ? '剧本生成已中断' : '剧本生成失败'}</h2></div>
        <p className="script-run-meta"><strong>{run.count} 个分镜</strong><span>{[run.service, run.model].filter(Boolean).join(' · ')}</span></p>
      </div>
      {writing && <div className="script-run-controls"><WaitTime created={run.created} now={now} />
        <button type="button" onClick={background}>转入后台</button></div>}
    </header>
    {writing && <FilmStrip />}
    <div className="script-run-foot">
      <div className="script-run-brief"><h3>本次故事构想</h3><p tabIndex={0}>{run.brief}</p></div>
      {!writing && <ServiceError message={run.error} context="writer" configure={configure} />}
      <div className="script-run-actions">
        <p>{writing ? '完成后会存入「我的剧本」。转入后台可继续写下一段剧情。' : '可以在「后台任务」中再次查看这次记录。'}</p>
        {!writing && <button type="button" onClick={edit}>{hasDraft ? '继续当前构想' : '取回构想'}</button>}
      </div>
    </div>
  </section>
}
