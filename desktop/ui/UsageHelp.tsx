import { Modal } from './Editor'
import { serviceIssue } from './taskHelp'

export function ServiceError({ message, context, configure }: {
  message: string
  context?: Parameters<typeof serviceIssue>[1]
  configure?: () => void
}) {
  const issue = serviceIssue(message, context)
  return <div className="service-error">
    <div role="alert">{issue ? <><strong>{issue.title}</strong><p>{issue.advice}</p></> : message}</div>
    {issue && <details><summary>技术详情</summary><p>{message}</p></details>}
    {issue?.connection && configure && <button type="button" className="link" onClick={configure}>检查模型配置</button>}
  </div>
}

export function UsageHelp({ close, settings }: { close: () => void; settings: (target: 'writer' | 'media' | 'files') => void }) {
  return <Modal title="使用帮助" close={close}>
    <div className="dialog-body usage-help">
      <details open><summary>第一次使用，在哪里连接模型？</summary>
        <p>生图和视频使用创作台选中的生成服务。使用官网时填写官网 OpenAPI Key，使用厂商或中转站时添加连接，选择相应协议并填写根地址和模型 ID。</p>
        <p>剧本和提示词优化共用一条文本模型连接。也可以直接用原文生图或生成视频。</p>
        <div><button onClick={() => settings('media')}>设置图片与视频</button><button onClick={() => settings('writer')}>设置文本模型</button></div>
      </details>
      <details><summary>模型列表取不到，或配置好了仍然报错</summary>
        <p>先核对服务根地址、协议、模型 ID 和 Key 所属账户。在连接里点「获取模型列表」可检查目录是否可访问。服务商未提供目录时，可手动填写模型 ID。</p>
        <p>能读取列表的账户也可能缺少生成权限。按报错检查模型是否开通、额度是否够用，以及尺寸、时长和参考素材是否受支持。</p>
      </details>
      <details><summary>图片或视频一直没有结果</summary>
        <p>打开「后台任务 → 查看进度」。已有服务商任务号时，应用会继续查原任务。遇到短时断网、限流或上游故障，等待倒计时结束即可。进度长时间没有变化时，可复制任务的排查信息核对服务商队列。</p>
        <p>如果还停在提交阶段，先保持应用打开。有些接口只在生成完成时返回成品。提交中断且没有编号时，请先按提交时间和模型到服务商查记录，以免重复计费。</p>
      </details>
      <details><summary>任务报错，怎样继续？</summary>
        <p>在「后台任务 → 待处理」打开任务详情。查询中断可继续查询原任务，下载中断可重新下载结果。已经返回失败的任务可复用参数，修改后再生成会创建新任务。</p>
        <p>技术详情里保留服务返回的信息。「复制排查信息」包含任务号、模型、时间和已收到的 HTTP 或官网状态码，可交给服务商定位问题。</p>
      </details>
      <details><summary>应用报错后，在哪里找日志？</summary>
        <p>在「设置 → 文件与工具 → 运行日志」打开目录，按报错时间查看 mobius.log。生成任务的详细原因在「后台任务 → 待处理」中。</p>
        <button onClick={() => settings('files')}>查看运行日志位置</button>
      </details>
    </div>
    <footer className="modal-actions"><button onClick={close}>关闭帮助</button></footer>
  </Modal>
}
