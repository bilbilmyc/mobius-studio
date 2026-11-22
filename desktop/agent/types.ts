import type { MediaKind, PromptResult, ShotLink } from '../shared'

export type PromptScope = { kind: MediaKind; shot?: ShotLink }
export type PromptSource = 'read_shot' | 'read_references'
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
export interface PromptSession { revision: number; turns: PromptTurn[]; memory: string }
export interface PromptAgentBridge {
  promptSession(scope: PromptScope): Promise<PromptSession>
  updatePromptSession(scope: PromptScope, revision: number, turn: PromptTurn | null): Promise<PromptSession>
  savePromptMemory(scope: PromptScope, previous: string, memory: string): Promise<string>
  promptShotContext(shot: ShotLink): Promise<{
    title: string; number: number; current: { heading: string; action: string; dialogue: string; imagePrompt: string; videoPrompt: string };
    previousHeading: string | null; nextHeading: string | null
  }>
  promptAgentStep(target: WriterTarget, messages: Message[]): Promise<PromptResult>
}
