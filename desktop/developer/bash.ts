import { bodyFile, type Argument, type RequestExample, type Variable, variables } from './model'

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
const env = (v: Variable) => '"${' + v.env + ':?Set ' + v.env + '}"'
function arg(v: Argument): string {
  if (typeof v === 'string') return quote(v)
  if (v.format === 'base64') return (v.prefix ? quote(v.prefix) : '') + '"$(base64 < ' + env(v) + " | tr -d '\\r\\n')\""
  return (v.prefix ? quote(v.prefix) : '') + env(v)
}
const disposition = (s: string) => s.replace(/[\\"\r\n]/g, c => c === '\r' ? '%0D' : c === '\n' ? '%0A' : '\\' + c)

export function bash(r: RequestExample): string {
  const setup: string[] = []
  const options = [
    'curl --globoff --silent --show-error',
    '--request ' + r.method,
    '--max-time ' + r.timeout,
    '--url ' + arg(r.url),
    ...r.headers.map(([k,v]) => '--header ' + (typeof v === 'string' ? quote(k + ': ' + v) : quote(k + ': ' + v.prefix) + env(v))),
  ]
  const b = r.body
  let tail = ''
  if (b.kind === 'file') {
    options.push('--data-binary @-')
    tail = ' < ' + env(bodyFile)
  }
  if (b.kind === 'form') {
    // Build UTF-8 multipart bytes before sending. Windows curl can recode both argv and filenames.
    setup.push('payload=$(mktemp)', "trap 'rm -f -- \"$payload\"' EXIT", 'boundary="mobius-$RANDOM-$RANDOM-$RANDOM-$RANDOM-$RANDOM"')
    if (b.fields.some(f => f.kind === 'file' && typeof f.filename !== 'string')) setup.push(
      'filename() {', '  local v=$1', '  v=${v//\\\\/\\\\\\\\}', '  v=${v//\\"/\\\\\\"}',
      "  v=${v//$'\\r'/%0D}", "  v=${v//$'\\n'/%0A}", "  printf '%s' \"$v\"", '}',
    )
    setup.push('{')
    for (const f of b.fields) {
      const header = 'Content-Disposition: form-data; name="' + disposition(f.name) + '"'
      if (f.kind === 'text') {
        setup.push("  printf '%s\\r\\n' \"--$boundary\" " + quote(header) + " ''")
        if (typeof f.value !== 'string' && f.value.format === 'base64') {
          setup.push("  printf '%s' " + quote(f.value.prefix), "  base64 < " + env(f.value) + " | tr -d '\\r\\n'", "  printf '\\r\\n'")
        } else setup.push("  printf '%s\\r\\n' " + arg(f.value))
      } else {
        const filename = typeof f.filename === 'string' ? quote(disposition(f.filename)) : '"$(filename ' + arg(f.filename) + ')"'
        setup.push("  printf '%s\\r\\n' \"--$boundary\" " + quote(header + '; filename="') + filename + quote('"') + ' ' + quote('Content-Type: ' + f.mime) + " ''",
          '  cat -- ' + env(f.file), "  printf '\\r\\n'")
      }
    }
    setup.push("  printf '%s\\r\\n' \"--$boundary--\"", '} > "$payload"')
    options.push('--header "Content-Type: multipart/form-data; boundary=$boundary"', '--data-binary @-')
    tail = ' < "$payload"'
  }
  if (b.kind === 'json' && b.pieces.every(p => typeof p === 'string')) {
    const json = b.pieces.join('')
    let delimiter = 'MOBIUS_JSON'
    while (json.split('\n').includes(delimiter)) delimiter += '_'
    options.push("--data-binary @- <<'" + delimiter + "'")
    tail = '\n' + json + '\n' + delimiter
  } else if (b.kind === 'json') {
    // Materialize before sending so an unreadable reference file cannot submit a partial job.
    setup.push('payload=$(mktemp)', 'trap \'rm -f -- "$payload"\' EXIT')
    if (b.pieces.some(p => typeof p !== 'string' && p.source.format === 'text')) setup.push(
      'json_string() {', '  local v=$1 i c esc', '  v=${v//\\\\/\\\\\\\\}', '  v=${v//\\"/\\\\\\"}',
      '  for ((i=1; i<32; i++)); do', '    printf -v c \'%b\' "$(printf \'\\\\x%02x\' "$i")"',
      "    printf -v esc '\\\\u%04x' \"$i\"", '    v=${v//"$c"/"$esc"}', '  done', '  printf \'"%s"\' "$v"', '}',
    )
    setup.push('{')
    for (const p of b.pieces) {
      if (typeof p === 'string') setup.push("  printf '%s' " + quote(p))
      else if (p.source.format === 'base64') setup.push(
        "  printf '%s' " + quote(JSON.stringify(p.source.prefix).slice(0,-1)),
        "  base64 < " + env(p.source) + " | tr -d '\\r\\n'", '  printf \'"\'',
      )
      else setup.push((p.source.format === 'json' ? "  printf '%s' " : '  json_string ') + arg(p.source))
    }
    setup.push('} > "$payload"')
    options.push('--data-binary @-')
    tail = ' < "$payload"'
  }
  const command = options.join(' \\\n  ') + tail
  const required = [...variables(r).keys()].map(name => ': ' + env({ env: name, prefix: '', format: 'text' }))
  return setup.length ? ['(', 'set -euo pipefail', ...required, ...setup, command, ')'].join('\n') : command
}
