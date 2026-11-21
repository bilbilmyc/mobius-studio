import type { ModelDraft, Picked, Protocol, Start } from '../shared'
export function draftSubmission(
  draft: Partial<ModelDraft> | undefined,
  mode: string,
  assets: Picked[],
  count: number,
  protocol: Protocol,
  limit?: number | null
): Pick<Start, 'count' | 'repeat' | 'mask' | 'sourceJob' | 'assets'> {
  const native = count > 1 && ['openai-image', 'wan-image'].includes(protocol) && (limit ?? 1) >= count
  return {
    count: native ? count : 1,
    repeat: native ? 1 : count,
    mask: mode === 'i2i' ? draft?.mask : undefined,
    sourceJob: draft?.sourceJob,
    assets,
  }
}
