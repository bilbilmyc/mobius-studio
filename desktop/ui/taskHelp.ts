import { useEffect, useState } from 'react'
import type { JobView } from '../shared'

type Context = 'generation' | 'catalog' | 'writer' | 'query' | 'download'
export interface Guidance { title: string; advice: string; connection?: boolean }

export function useVisibleTime(active: boolean, interval: number) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    let timer: number | undefined
    function sync() {
      window.clearInterval(timer)
      if (document.hidden) return
      setNow(Date.now())
      timer = window.setInterval(() => setNow(Date.now()), interval)
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', sync) }
  }, [active, interval])
  return now
}

export function serviceIssue(raw: string, context: Context = 'generation'): Guidance | undefined {
  const status = Number(raw.match(/(?:HTTP\s+|官网返回\s+)(\d{3})\b/i)?.[1])
  if (context === 'download' && [401, 403, 404, 410].includes(status))
    return { title: '结果文件暂时取不到', advice: '下载地址可能已过期或需要授权。可先到服务商的任务记录查看原文件。' }
  if (status === 402 || /insufficient[_ ](?:quota|balance|credit)|quota[_ ]exceeded|out of credits|billing_hard_limit|balance[_ ]not[_ ]enough|余额不足|额度(?:不足|已用尽|用完)/i.test(raw))
    return { title: '服务商账户额度不足', advice: '到当前 Key 所属账户核对可用额度、账单和项目限额，处理后再试。' }
  if (/content[_ ]?(?:filter|policy|moderation)|datainspectionfailed|safety[_ ]?(?:filter|violation)|内容审核|违规内容/i.test(raw))
    return { title: '服务商未通过内容审核', advice: '查看服务商给出的内容要求，检查提示词和参考素材，再决定是否修改。' }
  if (status === 401 || /invalid[_ ]api[_ ]key|未设置.*Key|请先.*(?:API Key|OpenAPI Key)|鉴权失败|unauthoriz/i.test(raw))
    return { title: '服务商未接受当前凭据', advice: '核对服务根地址，重新填写这个账户签发的 API Key 并保存。', connection: true }
  if (status === 403)
    return { title: '当前账户没有访问权限', advice: '核对 Key 所属项目、模型开通状态和接口权限。', connection: true }
  if (context === 'query' && [404, 410].includes(status))
    return { title: '服务商没有找到原任务', advice: '按服务商任务号核对账户和服务商记录。恢复会沿用原查询路径，若记录过期可凭任务号联系服务商。', connection: true }
  if (context === 'query' && /无法识别服务商状态/.test(raw))
    return { title: '服务商返回的状态暂时无法确认', advice: '任务号已保留。请先在服务商处核对进度，自定义连接还可核对状态字段和映射。', connection: true }
  if (/model[_ ]not[_ ]found|invalid[_ ]model|unknown model|模型不存在|未配置这个模型/i.test(raw))
    return { title: '所选模型不可用', advice: '在连接中获取模型列表，核对模型 ID、大小写和账户权限。', connection: true }
  if (context === 'catalog' && (status === 404 || status === 405 || /模型列表|不是 JSON/.test(raw)))
    return { title: '没有读到模型列表', advice: '核对服务根地址和协议。如果服务商未提供模型目录，可手动填写其模型 ID。', connection: true }
  if (status === 404 || status === 405 || /不是 JSON|服务根地址|接口路径|无法识别服务商状态|缺少媒体字段|缺少媒体地址/.test(raw))
    return { title: '服务地址或接口协议需要核对', advice: '检查服务根地址、版本路径和接口协议。自定义接口还需核对请求路径和返回字段。', connection: true }
  if (status === 429 || /rate[_ ]?limit|too many requests|限流|并发(?:数已达上限|超限)/i.test(raw))
    return { title: '服务商正在限流', advice: '等候服务商的重试时间，减少同时发起的任务。' }
  if (status === 413)
    return { title: '上传素材超出服务限制', advice: '减小素材的文件大小或数量，再按模型支持的规格提交。' }
  if (status === 400 || status === 415 || status === 422)
    return { title: '服务商拒绝了请求参数', advice: context === 'writer'
      ? '核对文本模型和消息格式，生成剧本还需支持 JSON 输出。'
      : '核对模型支持的尺寸、时长、素材格式和数量，检查自定义参数。', connection: context === 'writer' }
  if (/no space|disk full|磁盘空间|空间不足|os error (?:28|112)\b/i.test(raw))
    return { title: '本地磁盘空间不足', advice: '给作品目录所在磁盘腾出空间，再继续保存结果。' }
  if (status === 408 || status === 504 || /超时|timed? ?out|timeout/i.test(raw))
    return { title: '等待服务响应超时', advice: '检查网络或代理，并核对服务商的任务记录和服务状态。' }
  if (status >= 500 && status < 600)
    return { title: '服务商暂时不可用', advice: '查看服务商状态，等服务恢复后再操作。' }
  if (/无法连接服务|连接中断|error sending request|connection (?:refused|reset)|dns|网络连接/i.test(raw))
    return { title: '连接服务时中断', advice: '检查网络、代理和服务地址。本机模型还需确认服务进程已启动。', connection: true }
}

export function canResume(job: JobView) {
  return job.status === 'paused' && !!(job.remoteId || job.hasResultUrl)
}

export function interruptedDownload(job: JobView) {
  return job.stoppedDuring === 'downloading' || (!job.stoppedDuring && !!job.hasResultUrl)
}

export function taskGuidance(job: JobView, now: number): Guidance | undefined {
  const { status, remoteId, stoppedDuring, detail } = job
  const download = interruptedDownload(job)
  const issue = serviceIssue(detail, download ? 'download' : status === 'paused' ? 'query' : 'generation')
  if (status === 'uncertain')
    return { title: issue?.title || '尚未确认服务商是否已受理', connection: issue?.connection,
      advice: '没有取得任务号。先按提交时间和模型到服务商核对生成记录，查到结果可直接取回。确认未受理后再生成，以免重复计费。' }
  if (status === 'paused') {
    const next = !canResume(job) ? '这条记录缺少可恢复的编号或结果地址，请到服务商核对记录。'
      : download ? '用「重新下载结果」取回原文件。' : '用「继续查询原任务」查询已有编号。'
    return { title: issue?.title ?? (download ? '结果文件还没有保存到本机' : '原任务的进度查询已暂停'),
      advice: [issue?.advice, next].filter(Boolean).join(''), connection: issue?.connection }
  }
  if (status === 'failed') {
    const next = download ? '结果已返回，但本机未能保存。先到服务商查看原结果。'
      : stoppedDuring === 'preparing' ? '素材准备阶段已停止。检查文件是否存在、链接是否可用，再复用参数。'
      : remoteId ? '服务商已结束这次生成。可回创作台修改，再发起新任务。'
      : '可回创作台检查设置，确认后再生成。'
    return { title: issue?.title ?? (download ? '原文件保存失败' : stoppedDuring === 'preparing' ? '素材未准备好' : remoteId ? '服务商报告任务失败' : '本次生成未完成'),
      advice: [issue?.advice, next].filter(Boolean).join(''), connection: issue?.connection }
  }
  if (status === 'waiting' && job.retryAt)
    return { title: issue?.title || '查询暂时中断，正在自动重试', advice: '任务号已保存。倒计时结束后会自动重查同一任务，可以继续创作。' }
  const since = job.progressAt ?? job.created
  if (!since || now - since < (job.kind === 'video' ? 5 : 2) * 60_000) return
  if (status === 'waiting' && remoteId)
    return { title: '服务商有一段时间没有返回新进度', advice: '仍在按原任务号查询。可以继续创作，重开后也会接着查。需要核实时，可复制排查信息到服务商核对队列。' }
  if (status === 'submitting')
    return { title: '仍在等待提交响应', advice: '有些接口会直接返回成品。建议先保持应用打开，按提交时间和模型核对服务商记录，避免重复生成。' }
  if (status === 'downloading')
    return { title: '结果保存耗时较长', advice: '服务商已经返回结果。请保持网络连通，检查作品目录的可用空间。' }
  if (status === 'preparing')
    return { title: '素材准备或上传耗时较长', advice: '检查参考文件大小和上传网络。任务通过素材准备后才会提交生成。' }
}
