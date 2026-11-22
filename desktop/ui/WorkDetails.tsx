import { siteTemplate, statusLabels, type Integrations, type JobView } from '../shared'
import { CloudSave } from './CloudSave'
import { LibraryMarks, unmarked, type LibraryMark } from './LibraryMarks'

interface Props {
  job: JobView
  mark?: LibraryMark
  changed: (mark: LibraryMark) => void
  inspect: () => void
  settings?: Integrations
  configureStorage: () => void
  report: (message: string) => void
}

export function WorkDetails({
  job,
  mark,
  changed,
  inspect,
  settings,
  configureStorage,
  report,
}: Props) {
  const model = siteTemplate(job.model)?.Name || job.model || job.profileName
  return (
    <aside className="work-details" aria-label="所选作品操作">
      <header className="work-details-heading">
        <h2>作品详情</h2>
        <button onClick={inspect}>
          查看所选任务 <span aria-hidden="true">↗</span>
        </button>
      </header>
      <div className="work-description">
        <div className="work-media-info">
          <span>{job.kind === 'video' ? '视频' : '图片'}</span>
          <span>{statusLabels[job.status] || job.status}</span>
        </div>
        {job.prompt && (
          <p className="work-prompt" aria-label="所选作品提示词" title={job.prompt}>
            {job.prompt}
          </p>
        )}
      </div>
      <LibraryMarks id={job.id} mark={mark ?? unmarked} disabled={!mark} changed={changed} />
      <CloudSave job={job} settings={settings} configure={configureStorage} report={report} />
      <dl className="work-facts">
        {model && (
          <div>
            <dt>模型</dt>
            <dd>{model}</dd>
          </div>
        )}
        {job.shot?.label && (
          <div>
            <dt>分镜</dt>
            <dd>{job.shot.label}</dd>
          </div>
        )}
        <div>
          <dt>创建</dt>
          <dd>{new Date(job.created).toLocaleDateString()}</dd>
        </div>
      </dl>
    </aside>
  )
}
