import { bodyFile, variables, type Argument, type RequestExample } from './model'

const quoted = JSON.stringify
const raw = (s: string) => '`' + s.replaceAll('`', '` + "`" + `') + '`'
function value(v: Argument): string {
  if (typeof v === 'string') return quoted(v)
  const env = 'env(' + quoted(v.env) + ')'
  const data = v.format === 'base64' ? 'base64.StdEncoding.EncodeToString(must(os.ReadFile(' + env + ')))' : env
  return v.prefix ? quoted(v.prefix) + ' + ' + data : data
}
export function go(r: RequestExample): string {
  const b = r.body, imports = new Set(['io','net/http','os','time'])
  const helpers = ['func must[T any](v T, err error) T {', '\tif err != nil { panic(err) }', '\treturn v', '}']
  if (variables(r).size) helpers.push('', 'func env(name string) string {', '\tv := os.Getenv(name)',
    '\tif v == "" { panic("Set " + name) }', '\treturn v', '}')
  const main: string[] = []
  let reader = 'nil'
  if (b.kind === 'json') {
    imports.add('strings')
    const expressions = b.pieces.map(p => {
      if (typeof p === 'string') return raw(p)
      if (p.source.format === 'json') return value(p.source)
      if (p.source.format === 'base64') imports.add('encoding/base64')
      imports.add('encoding/json')
      return 'string(must(json.Marshal(' + value(p.source) + ')))'
    })
    main.push('body := strings.NewReader(' + expressions.join(' +\n\t\t') + ')')
    reader = 'body'
  } else if (b.kind === 'file') {
    main.push('body := must(os.Open(' + value(bodyFile) + '))','defer body.Close()')
    reader = 'body'
  } else if (b.kind === 'form') {
    imports.add('mime/multipart')
    helpers.push('', 'func check(err error) { if err != nil { panic(err) } }')
    if (b.fields.some(f => f.kind === 'file')) {
      imports.add('mime'); imports.add('net/textproto')
      helpers.push('', 'func addFile(w *multipart.Writer, field, path, filename, media string) {',
        '\tf := must(os.Open(path))', '\tdefer f.Close()', '\th := make(textproto.MIMEHeader)',
        '\th.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": field, "filename": filename}))',
        '\th.Set("Content-Type", media)', '\tpart := must(w.CreatePart(h))', '\tmust(io.Copy(part, f))', '}')
    }
    main.push('body := must(os.CreateTemp("", "mobius-form-*"))', 'defer os.Remove(body.Name())', 'defer body.Close()',
      'form := multipart.NewWriter(body)')
    for (const f of b.fields) {
      if (f.kind === 'file') main.push('addFile(form, ' + [quoted(f.name),value(f.file),value(f.filename),quoted(f.mime)].join(', ') + ')')
      else {
        if (typeof f.value !== 'string' && f.value.format === 'base64') imports.add('encoding/base64')
        main.push('check(form.WriteField(' + quoted(f.name) + ', ' + value(f.value) + '))')
      }
    }
    main.push('check(form.Close())','must(body.Seek(0, io.SeekStart))')
    reader = 'body'
  }
  main.push('req := must(http.NewRequest(' + quoted(r.method) + ', ' + value(r.url) + ', ' + reader + '))')
  if (b.kind === 'form') main.push('req.Header.Set("Content-Type", form.FormDataContentType())')
  if (b.kind === 'form' || b.kind === 'file') main.push('req.ContentLength = must(body.Stat()).Size()')
  for (const [k,v] of r.headers) {
    main.push(k.toLowerCase() === 'host' ? 'req.Host = ' + value(v) : 'req.Header.Add(' + quoted(k) + ', ' + value(v) + ')')
  }
  main.push('client := &http.Client{', '\tTimeout: ' + r.timeout + ' * time.Second,',
    '\tCheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },',
    '}', 'resp := must(client.Do(req))', 'defer resp.Body.Close()', 'must(io.Copy(os.Stdout, resp.Body))')
  return ['package main', '', 'import (', ...[...imports].sort().map(s => '\t' + quoted(s)), ')', '', ...helpers, '',
    'func main() {', ...main.map(l => '\t' + l), '}'].join('\n')
}
