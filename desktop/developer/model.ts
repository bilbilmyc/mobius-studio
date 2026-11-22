export type Language = 'Bash cURL' | 'Python' | 'Go'
export const languages: Language[] = ['Bash cURL', 'Python', 'Go']
export interface Variable { env: string; format: 'text' | 'base64' | 'json' | 'file'; prefix: string }
export type Argument = string | Variable
export interface Slot { path: (string | number)[]; source: Variable }
export type Field = { kind: 'text'; name: string; value: Argument }
  | { kind: 'file'; name: string; file: Variable; filename: Argument; mime: string }
export type Body = { kind: 'empty' | 'file' } | { kind: 'form'; fields: Field[] }
  | { kind: 'json'; pieces: (string | Slot)[] }
export interface RequestExample { method: string; url: Argument; headers: [string, Argument][]; body: Body; timeout: number }
export interface RequestSummary {
  id: number; time: number; method: string; target: string; status: number | null
  elapsedMs: number | null; outcome: 'pending' | 'received' | 'failed' | 'interrupted'
}
export const bodyFile: Variable = { env: 'BODY_FILE', format: 'file', prefix: '' }

export function variables(r: RequestExample) {
  const result = new Map<string, string>()
  function add(arg: Argument, label: string) {
    if (typeof arg === 'string') return
    const file = arg.format === 'file' || arg.format === 'base64'
    result.set(arg.env, file ? label + '的文件路径' : label)
  }
  add(r.url, '完整请求地址（签名链接需在有效期内）')
  for (const [name, arg] of r.headers) add(arg, name === 'authorization' && typeof arg !== 'string' && arg.env === 'API_KEY' ? '服务的 API Key' : name + ' 请求头的值')
  if (r.body.kind === 'file') add(bodyFile, '原始请求体')
  if (r.body.kind === 'json') for (const piece of r.body.pieces) {
    if (typeof piece !== 'string') add(piece.source, piece.path.join('.') || '请求体')
  }
  if (r.body.kind === 'form') for (const field of r.body.fields) {
    if (field.kind === 'file') {
      add(field.file, typeof field.filename === 'string' ? field.filename : field.name)
      add(field.filename, field.name + ' 文件名')
    } else add(field.value, field.name)
  }
  return result
}
