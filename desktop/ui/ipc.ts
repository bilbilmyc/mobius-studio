import { invoke as nativeInvoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core'
export { convertFileSrc } from '@tauri-apps/api/core'

type IssueKind = 'command' | 'script' | 'rejection' | 'react'
function record(kind: IssueKind, operation: string, error: unknown, line?: number, column?: number) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  void nativeInvoke('report_runtime_issue', { kind, operation, message: message.slice(0, 1800), line, column }).catch(() => {})
}

export async function invoke<T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  try { return await nativeInvoke<T>(command, args, options) }
  catch (error) { record('command', command, error); throw error }
}

export function reportScriptError(kind: 'script' | 'rejection' | 'react', error: unknown, line?: number, column?: number) {
  const name = error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError' :
    error instanceof ReferenceError ? 'ReferenceError' : error instanceof SyntaxError ? 'SyntaxError' : 'Error'
  const frame = error instanceof Error && error.stack?.split('\n').slice(1).join('\n').match(/\/(?:assets\/)?([\w-]+\.(?:js|tsx?)):(\d+):(\d+)/)
  record(kind, frame ? name + '.' + frame[1] : name, error, line || (frame ? +frame[2] : undefined), column || (frame ? +frame[3] : undefined))
}

window.addEventListener('error', e => reportScriptError('script', e.error ?? e.message, e.lineno, e.colno))
window.addEventListener('unhandledrejection', e => reportScriptError('rejection', e.reason))
