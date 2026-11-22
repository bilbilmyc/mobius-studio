import { bodyFile, variables, type Argument, type RequestExample } from './model'

const literal = (s: string) => s.includes('\n') ? "'''" + s.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'''" : JSON.stringify(s)
function value(v: Argument): string {
  if (typeof v === 'string') return literal(v)
  const env = 'os.environ[' + literal(v.env) + ']'
  const data = v.format === 'base64' ? 'base64.b64encode(Path(' + env + ').read_bytes()).decode("ascii")' : env
  return v.prefix ? literal(v.prefix) + ' + ' + data : data
}
export function python(r: RequestExample): string {
  const b = r.body
  const sources = [...variables(r).keys()]
  const pieces = b.kind === 'json' ? b.pieces : []
  const dynamic = pieces.some(p => typeof p !== 'string')
  const usesBase64 = pieces.some(p => typeof p !== 'string' && p.source.format === 'base64')
    || (b.kind === 'form' && b.fields.some(f => f.kind === 'text' && typeof f.value === 'object' && f.value.format === 'base64'))
  const files = b.kind === 'file' || (b.kind === 'form' && b.fields.some(f => f.kind === 'file'))
  const lines = [
    '# python -m pip install requests',
    ...(usesBase64 ? ['import base64', 'from pathlib import Path'] : []),
    ...(dynamic ? ['import json'] : []), ...(sources.length ? ['import os'] : []), 'import sys',
    ...(files ? ['from contextlib import ExitStack'] : []), '', 'import requests', '',
    'url = ' + value(r.url), 'headers = {', ...r.headers.map(([k,v]) => '    ' + literal(k) + ': ' + value(v) + ','), '}',
  ]
  if (b.kind === 'json') {
    const expressions = pieces.map(p => typeof p === 'string' ? literal(p)
      : p.source.format === 'json' ? value(p.source) : 'json.dumps(' + value(p.source) + ', ensure_ascii=False)')
    lines.push('payload = (' + expressions.join('\n    + ') + ')')
  }
  const indent = files ? '    ' : ''
  if (files) lines.push('', 'with ExitStack() as stack:')
  if (b.kind === 'form') {
    lines.push(indent + 'parts = [')
    for (const f of b.fields) {
      const tuple = f.kind === 'text' ? 'None, ' + value(f.value)
        : value(f.filename) + ', stack.enter_context(open(' + value(f.file) + ', "rb")), ' + literal(f.mime)
      lines.push(indent + '    (' + literal(f.name) + ', (' + tuple + ')),')
    }
    lines.push(indent + ']')
  }
  const body = b.kind === 'json' ? 'data=payload.encode("utf-8"),' : b.kind === 'form' ? 'files=parts,'
    : b.kind === 'file' ? 'data=stack.enter_context(open(' + value(bodyFile) + ', "rb")),' : ''
  lines.push(indent + 'with requests.request(', indent + '    ' + literal(r.method) + ', url, headers=headers,',
    ...(body ? [indent + '    ' + body] : []),
    indent + '    timeout=' + r.timeout + ', allow_redirects=False, stream=True,', indent + ') as response:',
    indent + '    for chunk in response.iter_content(65536):', indent + '        sys.stdout.buffer.write(chunk)')
  return lines.join('\n')
}
