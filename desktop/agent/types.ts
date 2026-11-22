import type { TemplateBridge } from './templates'
import type { MediaKind, PromptResult, ShotLink } from '../shared'

export type PromptScope = { kind: MediaKind; shot?: ShotLink }
export type PromptSource = 'read_shot' | 'read_references' | 'find_templates' | 'recall_drafts'
export type WriterTarget = { base: string; model: string }
export type Message = { role: 'system' | 'user' | 'assistant'; content: string }
export interface PromptTurn {
  user: string
  original: string
  reply: string
  prompt: string | null
  model: string
  sources: PromptSource[]
}
export interface PromptSession {
  revision: number
  turns: PromptTurn[]
  memory: string
}
export interface AgentStep {
  id: string
  native: boolean
  tools: PromptSource[]
  observations: { id: string; content: string }[]
}
export type ToolCall = { id: string; name: PromptSource; arguments: unknown }
export interface PromptAgentBridge extends TemplateBridge {
  promptSession(scope: PromptScope): Promise<PromptSession>
  updatePromptSession(
    scope: PromptScope,
    revision: number,
    turn: PromptTurn | null
  ): Promise<PromptSession>
  savePromptMemory(scope: PromptScope, previous: string, memory: string): Promise<string>
  promptShotContext(shot: ShotLink): Promise<{
    title: string
    number: number
    current: {
      heading: string
      action: string
      dialogue: string
      imagePrompt: string
      videoPrompt: string
    }
    previousHeading: string | null
    nextHeading: string | null
  }>
  promptAgentStep(
    target: WriterTarget,
    messages: Message[],
    run?: AgentStep
  ): Promise<PromptResult & { calls?: ToolCall[]; unsupported?: boolean }>
  finishPromptRun(id: string): Promise<void>
}
