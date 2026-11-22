import type { Picked, PromptReferences } from '../shared'
import type { PromptAgentBridge, PromptScope, PromptSession, PromptSource } from './types'
import { matchScore } from './templates'

export interface WritingContext {
  scope: PromptScope
  original: string
  candidate: string
  references: PromptReferences
  assets: Picked[]
}
export const sourceLabels: Record<PromptSource, string> = {
  read_shot: '分镜资料',
  read_references: '参考素材信息',
  find_templates: '提示词模板',
  recall_drafts: '历史改稿',
}
export function availableTools(context: WritingContext, session: PromptSession) {
  const tools = new Set<PromptSource>()
  if (context.scope.shot) tools.add('read_shot')
  if (context.assets.length) tools.add('read_references')
  tools.add('find_templates')
  if (session.turns.some((t) => t.prompt)) tools.add('recall_drafts')
  return tools
}
export async function readTool(
  bridge: PromptAgentBridge,
  context: WritingContext,
  session: PromptSession,
  source: PromptSource,
  args: unknown
) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('工具参数无效。')
  const keys = Object.keys(args)
  if (source === 'find_templates' || source === 'recall_drafts') {
    const query = 'query' in args && typeof args.query === 'string' ? args.query.trim() : ''
    if (keys.length !== 1 || !query || query.length > 120)
      throw Error('查找资料需要 1 到 120 字的关键词。')
    if (source === 'find_templates') return bridge.findPromptTemplates(context.scope.kind, query)
    const number = query.match(/^(?:第\s*)?(\d+)(?:\s*[轮版稿])?$/u)
    return session.turns
      .map((t, i) => ({
        turn: i + 1,
        t,
        score: number
          ? Number(number[1]) === i + 1
            ? 1
            : 0
          : matchScore(query, [t.user, t.prompt ?? '', t.reply]),
      }))
      .filter((x) => x.t.prompt && x.score)
      .sort((a, b) => b.score - a.score || b.turn - a.turn)
      .slice(0, 3)
      .map(({ turn, t }) => ({ turn, request: t.user.slice(0, 500), prompt: t.prompt!.slice(0, 3200) }))
  }
  if (keys.length) throw Error('此工具不接受额外参数。')
  if (source === 'read_shot') {
    if (!context.scope.shot) throw Error('当前未绑定分镜。')
    const shot = await bridge.promptShotContext(context.scope.shot)
    const current = shot.current
    return {
      title: shot.title,
      number: shot.number,
      previousHeading: shot.previousHeading?.slice(0, 500),
      nextHeading: shot.nextHeading?.slice(0, 500),
      heading: current.heading.slice(0, 1000),
      action: current.action.slice(0, 3500),
      dialogue: current.dialogue.slice(0, 2000),
      prompt: (context.scope.kind === 'video' ? current.videoPrompt : current.imagePrompt).slice(
        0,
        3500
      ),
    }
  }
  const counts: Record<string, number> = {}
  for (const item of context.assets) counts[item.kind] = (counts[item.kind] ?? 0) + 1
  return { arrangement: context.references, counts }
}
