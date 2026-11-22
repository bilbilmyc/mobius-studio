import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

const execute = promisify(execFile)
const key = 'fixture-credential-never-in-clipboard'
const password = 'fixture-secret "tab\t换行\n反斜\\线&'
const signature = 'fixture-private-signature'
const prompt = "晨光 '单引号' 和 \"双引号\"，保留 `shell`、$(echo literal) 与 {{变量}}\n第二行。"
const languages = ['Bash cURL', 'Python', 'Go']

export function exampleFixture(png) {
  const seen = []
  const started = Promise.withResolvers(), release = Promise.withResolvers()
  return { seen, started:started.promise, release:release.resolve, async handle(req, res, bytes) {
    const url = new URL(req.url, 'http://' + req.headers.host)
    const type = req.headers['content-type'] || ''
    let body
    if (type.startsWith('multipart/form-data')) {
      const parts = await new Response(bytes, { headers: { 'content-type': type } }).formData()
      body = await Promise.all([...parts.entries()].map(async ([name,v]) => [name, typeof v === 'string' ? v
        : [v.name, v.type, Buffer.from(await v.arrayBuffer()).toString('base64')]]))
    } else if (type.includes('json')) body = JSON.parse(bytes)
    else body = bytes.toString('base64')
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || req.headers['x-api-key'] || req.headers['x-auth-token'], body })
    const json = value => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(value)) }
    if (url.pathname.endsWith('/models')) {
      if (url.pathname.includes('/slow/')) { started.resolve(); await release.promise }
      if (url.pathname.includes('/disconnect/')) { req.socket.destroy(); return }
      if (url.pathname.includes('reject')) { res.statusCode = 403; return json({error:{message:'fixture denied'}}) }
      return json({data:[{id:'local-image'}]})
    }
    if (url.pathname.endsWith('/chat/completions')) return json({choices:[{finish_reason:'stop',message:{content:'晨光照进窗户。'}}]})
    if (url.pathname.endsWith('/upload/presign')) return json({code:0,data:{upload_url:url.origin + '/upload?sig=' + signature, path:'media/a.png'}})
    if (url.pathname === '/upload') { res.end('stored'); return }
    if (url.pathname.endsWith('/tasks/create')) return json({code:0,data:{task_id:'from-fixture'}})
    if (url.pathname.endsWith('/tasks/from-fixture')) return json({code:0,data:{status:'completed',result_oss_url:url.origin+'/fixture-private-path/output.png'}})
    if (url.pathname === '/fixture-private-path/output.png') { res.setHeader('content-type','image/png'); return res.end(png) }
    return json({data:[{b64_json:png.toString('base64')}]})
  }}
}

export async function exerciseExamples({page, base, temp, png, templates, fixture, done, record, restart, shot}) {
  const button = (name, scope=page) => scope.getByRole('button',{name,exact:true})
  const history = () => page.getByRole('dialog',{name:'请求记录'})
  async function setting() { await button('设置').click(); await button('开发者模式').click() }
  const models = () => page.evaluate(({base,key}) => window.studio.discoverModels({source:'writer',base,key}), {base,key})
  await models()
  assert.deepEqual(await page.evaluate(() => window.studio.requestHistory()), [])
  assert.equal(await button('请求记录').count(),0)
  await setting()
  await page.getByLabel('启用开发者模式').click()
  await button('请求记录').click()
  await history().getByText(/还没有请求/).waitFor()
  await page.keyboard.press('Escape')
  await models()
  await page.evaluate(async ({base,key,prompt}) => {
    await window.studio.saveWriter({base,model:'fixture-writer',key})
    await window.studio.optimizePrompt({kind:'image', mode:'polish', references:'none', prompt})
  },{base,key,prompt})
  const file = path.join(temp,'参考 file.png')
  await writeFile(file,png)
  const [image] = await page.evaluate(path => window.studio.drop('image',[path]),file)
  const profile = protocol => record({base,key,protocol,name:protocol,model:'local-image'})
  const ordinary = await profile('openai-image')
  const submit = async (profileId, options={}) => done(await page.evaluate(input => window.studio.start(input), {
    profileId,kind:'image',template:'',prompt,size:'1024x1024',seconds:0,priority:0,config:{},assets:[],...options,
  }))
  await submit(ordinary)
  await submit(ordinary,{assets:[image],config:{mode:'i2i'}})
  const mapped = await record({base,key,protocol:'relay-image',name:'dynamic',model:'custom',relay:{
    auth:'x-api-key',submit:'dynamic',url:'data.0.url',base64:'data.0.b64_json',sizes:['1024x1024'],
    body:'{"prompt":"{{prompt}}"}',workflows:{i2i:{submit:'dynamic',encoding:'json',
      body:JSON.stringify({prompt:'{{prompt}}',image:'{{image}}',options:{password}})}},
  }})
  await submit(mapped,{assets:[image],config:{mode:'i2i'}})
  const t = templates.find(t => !t.Video && (t.AnyReference || t.Slots.some(s => s.Kind==='image' && s.Max > 0)))
  const official = await profile('rh-image')
  await submit(official,{template:t.Key, assets:[image], prompt:t.Text ? prompt : '',
    config:Object.fromEntries(t.Fields.map(f => [f.Key,f.Default])),priority:t.Rate===t.FastRate?0:1})
  await assert.rejects(page.evaluate(({base,key}) => window.studio.discoverModels({source:'writer',base:base+'/reject',key}),{base,key}))
  const originals = [...fixture.seen].slice(1)
  const rows = await page.evaluate(() => window.studio.requestHistory())
  assert.equal(rows.length,originals.length)
  assert.equal(rows[0].status,403)
  const examples = await page.evaluate(async rows => Promise.all(rows.map(r=>window.studio.requestExample(r.id))),rows)
  const safe = JSON.stringify([rows,examples])
  for (const secret of [key,'fixture-secret',signature,'fixture-private-path',png.toString('base64')]) assert.ok(!safe.includes(secret))
  await button('请求记录').click()
  const dlg = history()
  await dlg.getByRole('navigation',{name:'已发送的请求'}).getByRole('button').first().waitFor()
  const saveClipboard = process.platform==='win32'
    ? async () => (await execute('powershell.exe',['-NoProfile','-STA','-Command','[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Write((Get-Clipboard -Raw))'],{windowsHide:true})).stdout
    : () => page.evaluate(() => navigator.clipboard.readText())
  const paths = { 'Bash cURL':'example.sh', Python:'example.py', Go:'main.go' }
  const programs = { 'Bash cURL': process.env.MOBIUS_BASH || (process.platform==='win32' ? path.join(process.env.ProgramFiles,'Git','bin','bash.exe') : 'bash'), Python:process.env.MOBIUS_PYTHON || 'python', Go:'go' }
  const cases = ['GET /v1/models','POST /v1/chat/completions','POST /v1/images/generations',
    'POST /v1/images/edits','POST /v1/dynamic','PUT /upload','GET /fixture-private-path/output.png']
  let runs = 0
  for (const which of cases) {
    const originalIndex = originals.findIndex(r => r.method + ' ' + r.url.split('?')[0] === which)
    assert.notEqual(originalIndex,-1,which)
    const original = originals[originalIndex], index = rows.length-1-originalIndex, example = examples[index]
    await dlg.getByRole('navigation').getByRole('button').nth(index).click()
    const env = {...process.env, API_KEY:key, BODY_FILE:file, REQUEST_URL:new URL(original.url,base).href,
      PYTHONUTF8:'1', NO_PROXY:'127.0.0.1,localhost', no_proxy:'127.0.0.1,localhost' }
    const fill = part => {
      if (typeof part === 'string') return
      if (part.format === 'base64' || part.format === 'file') env[part.env] = file.replaceAll('\\','/')
      if (part.env.startsWith('VALUE_')) env[part.env] = password
    }
    for (const f of example.body.fields || []) fill(f.kind==='file'?f.file:f.value)
    for (const p of example.body.pieces || []) if (typeof p !== 'string') fill(p.source)
    for (const language of languages) {
      await button(language,dlg).click()
      const code = await dlg.getByLabel(language+' 代码').innerText()
      const before = fixture.seen.length
      await button('复制代码',dlg).click()
      await dlg.getByRole('status').filter({hasText:'已复制 '+language}).waitFor()
      const clipboard = await saveClipboard()
      assert.equal(clipboard.replaceAll('\r\n','\n'),code)
      assert.equal(fixture.seen.length,before,'copy submitted another request')
      await writeFile(path.join(temp,paths[language]),clipboard.replaceAll('\r\n','\n'))
      await execute(programs[language],language==='Go'?['run',paths.Go]:[paths[language]],{cwd:temp,env,windowsHide:true,timeout:90000,encoding:'buffer'})
      assert.equal(fixture.seen.length,before+1)
      assert.deepEqual(fixture.seen.at(-1),original,which+' '+language)
      runs++
    }
    if (which==='POST /v1/images/generations') {
      await button('Bash cURL',dlg).click()
      await shot('开发者模式-请求记录')
    }
  }
  const slow = page.evaluate(base => window.studio.discoverModels({source:'writer',base:base+'/slow'}),base)
  try {
    await fixture.started
    await dlg.getByRole('navigation').getByRole('button').filter({hasText:'发送中'}).waitFor()
    await button('清空记录',dlg).click()
    await dlg.getByText(/还没有请求/).waitFor()
  } finally { fixture.release(); await slow }
  assert.deepEqual(await page.evaluate(() => window.studio.requestHistory()),[])
  await assert.rejects(page.evaluate(base => window.studio.discoverModels({source:'writer',base:base+'/disconnect'}),base))
  await dlg.getByRole('navigation').getByRole('button').filter({hasText:'连接失败'}).waitFor()
  const viewport = await page.evaluate(() => ({width:innerWidth,height:innerHeight}))
  await page.setViewportSize({width:720,height:560})
  const bounds = await dlg.evaluate(d => ({width:d.clientWidth, content:d.scrollWidth,
    tabRows:new Set([...d.querySelectorAll('.dev-code-tools .segments button')].map(b=>b.getBoundingClientRect().top)).size}))
  assert.ok(bounds.content <= bounds.width+1)
  assert.equal(bounds.tabRows,1)
  await page.setViewportSize(viewport)
  const persisted = await restart()
  page = persisted
  await button('请求记录').click()
  await history().getByText(/还没有请求/).waitFor()
  await models()
  await history().getByRole('navigation').getByRole('button').first().waitFor()
  await button('清空记录',history()).click()
  await history().getByText(/还没有请求/).waitFor()
  await page.keyboard.press('Escape')
  await models()
  await setting(); await page.getByLabel('启用开发者模式').click()
  await button('请求记录').waitFor({state:'hidden'})
  await models()
  assert.deepEqual(await page.evaluate(() => window.studio.requestHistory()),[])
  console.log('Native developer mode: '+runs+' clipboard examples replayed, HTTP 403, clear, disable and restart verified')
}
