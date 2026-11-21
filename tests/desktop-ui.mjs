import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { creationMock, exerciseCreation } from './creation-matrix.mjs'
import { workspaceMock, exerciseWorkspace } from './workspace-flows.mjs'

// The release WebView runs against disposable files and HTTP servers on this machine.
const root = fileURLToPath(new URL('../', import.meta.url))
const exe = path.resolve(
  process.argv[2] ?? path.join(root, 'dist/Mobius-Windows-x64/莫比环.exe'),
)
const templates = JSON.parse(
  await readFile(path.join(root, 'src/RhTemplates.json'), 'utf8'),
)
const temp = await mkdtemp(path.join(tmpdir(), 'mobius-native-ui-'))
const data = path.join(temp, 'Data')
const captures = process.env.MOBIUS_SCREENSHOTS
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQqHkGAAJaAYvrcg4EAAAAAElFTkSuQmCC',
  'base64',
)
const errors = [],
  requests = [],
  tickets = new Map()
let child, browser, page, relay, files

async function listen(handler) {
  const server = createServer(
    (req, res) =>
      void (async () => {
        const parts = []
        for await (const part of req) parts.push(part)
        try {
          await handler(req, res, Buffer.concat(parts))
        } catch (e) {
          errors.push(String(e))
          res.writeHead(500)
          res.end('mock rejected unexpected request')
        }
      })(),
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}
const origin = (s) => 'http://127.0.0.1:' + s.address().port
const json = (res, data) => {
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}
async function closeServer(s) {
  if (!s) return
  const done = once(s, 'close')
  s.close()
  s.closeAllConnections()
  await done
}
async function stop() {
  if (child?.exitCode === null && !child.killed) {
    const done = once(child, 'exit')
    child.kill()
    await done
  }
  child = undefined
  await browser?.close().catch(() => {})
  browser = undefined
}
async function start() {
  const socket = await listen(() => {}),
    endpoint = origin(socket),
    port = socket.address().port
  await closeServer(socket)
  child = spawn(exe, [], {
    cwd: temp,
    stdio: 'ignore',
    env: {
      ...process.env,
      MOBIUS_HOME: data,
      WEBVIEW2_USER_DATA_FOLDER: path.join(temp, 'WebView'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        '--remote-debugging-address=127.0.0.1 --remote-debugging-port=' + port,
    },
  })
  let targets = []
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null)
      throw Error(
        'QA instance exited before providing a WebView. Close other Tauri copies first.',
      )
    try {
      targets = await (await fetch(endpoint + '/json/list')).json()
      if (
        targets.some(
          (t) => t.type === 'page' && t.url.includes('tauri.localhost'),
        )
      )
        break
    } catch {}
    await delay(250)
  }
  assert.ok(
    targets.some((t) => t.type === 'page' && t.url.includes('tauri.localhost')),
    'packaged WebView was not ready',
  )
  browser = await chromium.connectOverCDP(endpoint)
  page = undefined
  for (let i = 0; i < 100 && !page; i++) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('tauri.localhost'))
    if (!page) await delay(80)
  }
  assert.ok(page, 'WebView target did not navigate')
  page.on('pageerror', (e) => errors.push(e.message))
  await page.getByRole('button', { name: '连接官网 Key' }).waitFor()
  await page.waitForFunction(
    () => document.querySelector('.canvas img')?.naturalWidth > 0,
  )
}
async function state() {
  return page.evaluate(() => window.studio.state())
}
async function record(profile) {
  return page.evaluate((p) => window.studio.save(p), profile)
}
async function done(id) {
  const until = Date.now() + 25000
  do {
    const job = (await state()).jobs.find((j) => j.id === id)
    if (job && ['done', 'failed', 'uncertain', 'paused'].includes(job.status)) {
      assert.equal(job.status, 'done', job.detail + ' ' + errors.join(' '))
      assert.ok(job.file)
      return job
    }
    await delay(90)
  } while (Date.now() < until)
  throw Error(
    'Timed out waiting for local task ' + id + ' ' + JSON.stringify(errors),
  )
}
async function shot(name) {
  if (captures) {
    await mkdir(captures, { recursive: true })
    await page.screenshot({ path: path.join(captures, name + '.png') })
  }
}

try {
  for (const dir of ['tasks', '作品'])
    await mkdir(path.join(data, dir), { recursive: true })
  const oldId = 'a'.repeat(32)
  await writeFile(path.join(data, '作品', 'old.png'), png)
  await writeFile(
    path.join(data, 'tasks', oldId + '.json'),
    JSON.stringify({
      Id: oldId,
      ProfileId: 'legacy',
      ProfileName: '旧版',
      ProtocolId: 'rh-image',
      BaseUrl: 'https://queueapi.vylai.com/openapi',
      Model: templates[0].Key,
      Prompt: '旧版测试作品',
      Size: '9:16',
      Seconds: 0,
      Reference: null,
      Status: 'done',
      Detail: '',
      RemoteId: null,
      ResultUrl: null,
      FileName: 'old.png',
      CreatedUtc: '/Date(1780000000000)/',
    }),
  )
  const videoFile = path.join(temp, 'clip.mp4')
  const ff = spawnSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=96x64:d=1',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-threads',
    '1',
    '-movflags',
    '+faststart',
    videoFile,
  ])
  assert.equal(ff.status, 0, 'UI tests require FFmpeg on PATH')
  const video = await readFile(videoFile)
  await writeFile(path.join(temp, 'tone.wav'), Buffer.from('RIFF sample'))
  files = await listen((req, res) => {
    for (const h of ['authorization', 'x-auth-token', 'x-api-key'])
      assert.equal(req.headers[h], undefined, 'credential in media request')
    if (req.method === 'PUT') {
      requests.push('put')
      res.end()
      return
    }
    assert.ok(['/out.mp4', '/out.png'].includes(req.url))
    res.end(req.url.endsWith('mp4') ? video : png)
  })
  const clip = origin(files) + '/out.mp4',
    still = origin(files) + '/out.png'
  const matrix = creationMock({ clip, still, png })
  const workspace = workspaceMock(png)
  relay = await listen(async (req, res, bytes) => {
    if (workspace.handle(req, res, bytes)) return
    if (await matrix.handle(req, res, bytes)) return
    const url = req.url,
      headers = req.headers
    requests.push(req.method + ' ' + url)
    const body = () => JSON.parse(bytes.toString())
    if (url === '/v1/models') {
      assert.equal(headers.authorization, 'Bearer demo-image')
      return json(res, { data: [{ id: 'local-image' }, { id: 'local-image-fast' }] })
    }
    if (url === '/v1/images/generations') {
      assert.equal(headers.authorization, 'Bearer demo-image')
      assert.equal(body().model, body().prompt === '自定义中转站图片' ? 'local-image-fast' : 'local-image')
      return json(res, { data: [{ b64_json: png.toString('base64') }] })
    }
    if (url === '/v1/videos') {
      assert.equal(headers.authorization, 'Bearer demo-video')
      assert.match(headers['content-type'], /multipart/)
      assert.match(bytes.toString(), /name="seconds"\r\n\r\n4/)
      assert.match(bytes.toString(), /name="input_reference"/)
      return json(res, { id: 'movie' })
    }
    if (url === '/v1/videos/movie') {
      assert.equal(headers.authorization, 'Bearer demo-video')
      return json(res, { status: 'completed' })
    }
    if (url === '/v1/videos/movie/content') {
      assert.equal(headers.authorization, 'Bearer demo-video')
      res.writeHead(302, { Location: clip })
      return res.end()
    }
    if (url === '/v1/mapped') {
      assert.equal(headers['x-api-key'], 'demo-map')
      const p = body()
      assert.equal(p.request.duration, 7)
      assert.equal(p.request.tag, '镜头：保持 {{size}}')
      return json(res, { ref: { id: 'abc' } })
    }
    if (url === '/v1/status/abc') {
      assert.equal(headers['x-api-key'], 'demo-map')
      return json(res, { task: { stage: 'ready', result: clip } })
    }
    if (url === '/v1/custom-image') {
      assert.equal(headers['x-api-key'], 'demo-map')
      return json(res, { outputs: [{ picture: still }] })
    }
    if (url === '/v1/upload/presign') {
      assert.equal(headers['x-auth-token'], 'demo-site')
      return json(res, {
        code: 0,
        data: {
          upload_url: origin(files) + '/put',
          required_headers: { 'Content-Type': body().content_type },
          path: 'saved/' + body().filename,
        },
      })
    }
    if (url === '/v1/tasks/create') {
      assert.equal(headers['x-auth-token'], 'demo-site')
      const p = body(),
        t = templates.find((t) => t.Key === p.template_key)
      assert.ok(t)
      assert.deepEqual(
        p.config_values,
        Object.fromEntries(t.Fields.map((f) => [f.Key, f.Default])),
      )
      assert.equal(p.priority, t.Rate === t.FastRate ? 0 : 1)
      for (const slot of t.Slots)
        if (slot.Min > 0) assert.equal(p[slot.Kind + '_path'].length, slot.Min)
      if (t.Text) assert.equal(p.extra_data.text, '模板回归')
      else assert.equal(p.extra_data, undefined)
      tickets.set(t.Key, t.Video ? clip : still)
      return json(res, { code: 200, data: { task_id: t.Key } })
    }
    if (url.startsWith('/v1/tasks/rh-')) {
      assert.equal(headers['x-auth-token'], undefined)
      return json(res, {
        code: 200,
        data: {
          status: 'completed',
          result_oss_url: tickets.get(url.split('/').pop()),
        },
      })
    }
    if (url.includes('/services/aigc/')) {
      assert.equal(headers['x-dashscope-async'], 'enable')
      assert.equal(headers.authorization, 'Bearer demo-legacy')
      return json(res, { output: { task_id: body().model } })
    }
    if (url === '/v1/tasks/wan-image')
      return json(res, {
        output: { task_status: 'SUCCEEDED', results: [{ url: still }] },
      })
    if (url === '/v1/tasks/wan-video')
      return json(res, {
        output: { task_status: 'SUCCEEDED', video_url: clip },
      })
    if (url === '/v1/contents/generations/tasks') {
      assert.equal(headers.authorization, 'Bearer demo-legacy')
      return json(res, { id: 'ark' })
    }
    if (url === '/v1/contents/generations/tasks/ark')
      return json(res, { status: 'succeeded', content: { video_url: clip } })
    throw Error('Unexpected mock endpoint ' + url)
  })
  const base = origin(relay) + '/v1'
  await start()
  assert.equal((await state()).jobs.length, 1)
  const service = page.getByLabel('生成服务'),
    tpl = page.getByLabel('官网模板')
  assert.equal(await service.inputValue(), '@site')
  assert.equal(await tpl.locator('option').count(), 3)
  await page.getByRole('button', { name: '视频', exact: true }).click()
  assert.equal(await service.inputValue(), '@site')
  assert.equal(await tpl.locator('option').count(), 9)
  await tpl.selectOption(templates.find((t) => t.Name.includes('Flash')).Key)
  await shot('视频设置')
  const prompt = page.locator('#prompt')
  const scenes = [
    '全景。摄影棚保持暗场，镜头从黑曜石台面的倒影缓慢抬升。先看到一道冰蓝色的高光，再让悬浮的金属环完整进入画面。',
    '微距。沿拉丝表面平稳向右横移，焦点停在半扭转处。边缘从银色逐渐过渡到紫色，背景维持深黑，保留细微划痕。',
    '侧面。镜头绕过金属带内侧，放慢移动速度。倒影与主体短暂重合，光线掠过曲面时，让纹理从远处逐层显现。',
    '收尾。缓慢拉远，在冰蓝与紫色轮廓光交汇的位置停住。最后一秒保持构图稳定，让台面反光和环境声一起淡出。',
  ]
  const long = Array.from(
    { length: 120 },
    (_, i) =>
      '镜头 ' +
      String(i + 1).padStart(3, '0') +
      '　' +
      scenes[i % scenes.length],
  ).join('\n\n')
  await prompt.fill(long)
  assert.ok(
    await prompt.evaluate(
      (el) => el.scrollHeight > el.clientHeight && el.clientHeight <= 207,
    ),
  )
  const typography = await prompt.evaluate((el) =>
    ['fontFamily', 'fontSize', 'lineHeight', 'fontWeight'].every(
      (k) =>
        getComputedStyle(el)[k] === getComputedStyle(el, '::placeholder')[k],
    ),
  )
  assert.ok(typography, 'placeholder and entered text have unequal metrics')
  await page.getByRole('button', { name: '展开编辑' }).click()
  const full = page.getByLabel('完整提示词')
  assert.ok(
    await full.evaluate(
      (el) =>
        el.clientHeight > document.getElementById('prompt').clientHeight + 100,
    ),
    'expanded editor must show substantially more text',
  )
  assert.equal(await full.inputValue(), long)
  await full.fill(long + '终幕')
  await full.press('Control+Enter')
  assert.equal(await prompt.inputValue(), long + '终幕')
  await page.getByRole('button', { name: '展开编辑' }).click()
  await shot('长文编辑')
  await full.fill('不保存')
  await full.press('Escape')
  assert.equal(await prompt.inputValue(), long + '终幕')
  const footer = await page.locator('.generate').boundingBox()
  assert.ok(
    footer.y + footer.height <= (await page.evaluate(() => innerHeight)),
  )
  await page.getByRole('button', { name: '作品库', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('.thumb img')?.naturalWidth === 1,
  )
  await page.locator('.card').dblclick()
  await page.waitForFunction(
    () => document.querySelector('img[alt="作品预览"]')?.naturalWidth === 1,
  )
  await page.getByRole('button', { name: '按尺寸导出', exact: true }).click()
  const exportBox = page.getByRole('dialog', { name: '按尺寸导出图片' })
  await exportBox.getByLabel('宽度（像素）').fill('160')
  await exportBox.getByLabel('高度（像素）').fill('90')
  await exportBox.getByLabel('适配方式').selectOption('contain')
  await exportBox.getByRole('button', { name: '导出到作品目录' }).click()
  await exportBox.waitFor({ state: 'hidden' })
  const outputFolder = path.join(data, '作品', '导出'),
    exports = await readdir(outputFolder)
  assert.equal(exports.length, 1)
  const copy = await readFile(path.join(outputFolder, exports[0]))
  assert.equal(copy.readUInt32BE(16), 160)
  assert.equal(copy.readUInt32BE(20), 90)
  assert.deepEqual(await readFile(path.join(data, '作品', 'old.png')), png)
  await page.getByRole('button', { name: '作为视频首帧' }).click()
  await page.locator('.file-row').waitFor()
  assert.equal(await page.locator('.file-row').count(), 1)
  await page.getByRole('button', { name: '图片', exact: true }).click()
  await page.getByRole('button', { name: '管理模型连接' }).click()
  await page.getByRole('button', { name: '添加模型服务' }).click()
  let dialog = page.getByRole('dialog')
  await dialog.getByLabel('连接名称').fill('测试图片')
  await dialog.getByLabel('服务根地址').fill(new URL(base).origin)
  await dialog.getByLabel('API Key').fill('demo-image')
  await dialog.getByRole('button', { name: '获取模型列表' }).click()
  await dialog.getByLabel('从服务商选择模型').selectOption('local-image')
  await dialog.getByText('同一连接的其他模型', { exact: true }).click()
  await dialog.getByLabel('从列表加入备选模型').selectOption('local-image-fast')
  await dialog.getByRole('button', { name: '保存连接' }).click()
  await page.getByRole('button', { name: '创作台', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('[aria-label="生成服务"]').value !== '@site',
  )
  const modelSelect = page.getByLabel('生成模型', { exact: true })
  const storedModels = await page.evaluate(async () => {
    const profile = (await window.studio.state()).profiles.find((p) => p.Name === '测试图片')
    return [profile?.Model, ...(profile?.Models ?? [])]
  })
  assert.deepEqual(storedModels, ['local-image', 'local-image-fast'])
  assert.equal(await modelSelect.inputValue(), 'local-image')
  await modelSelect.selectOption('local-image-fast')
  await prompt.fill('自定义中转站图片')
  await page.getByRole('button', { name: '生成图片' }).click()
  await page.waitForFunction(async () =>
    (await window.studio.state()).jobs.some(
      (j) => j.prompt === '自定义中转站图片' && j.model === 'local-image-fast' && j.status === 'done',
    ),
  )
  await modelSelect.selectOption('local-image')
  await page.getByRole('button', { name: '作品库', exact: true }).click()
  await page.getByLabel('筛选作品').selectOption('image')
  await page.locator('.card').filter({ hasText: '自定义中转站图片' }).dblclick()
  await page.getByRole('button', { name: '复用参数' }).click()
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="生成模型"]')?.value === 'local-image-fast')
  assert.equal(await modelSelect.inputValue(), 'local-image-fast')
  assert.equal(await prompt.inputValue(), '自定义中转站图片')
  console.log(
    'Native long editor, 12 template selectors, legacy gallery, relay model discovery and switching passed',
  )
  const pick = async (kind, file) =>
    (
      await page.evaluate(
        ({ kind, file }) => window.studio.drop(kind, [file]),
        { kind, file },
      )
    )[0]
  const picks = {
    image: await pick('image', path.join(data, '作品', 'old.png')),
    video: await pick('video', videoFile),
    audio: await pick('audio', path.join(temp, 'tone.wav')),
  }
  async function submit(id, kind, opts) {
    return done(
      await page.evaluate((input) => window.studio.start(input), {
        profileId: id,
        kind,
        template: '',
        prompt: '测试',
        size: '1280x720',
        seconds: 4,
        priority: 0,
        config: {},
        assets: [],
        ...opts,
      }),
    )
  }
  const profile = (protocol, key, model = protocol) => ({
    base,
    name: protocol,
    protocol,
    key,
    model,
  })
  const vid = await record(profile('openai-video', 'demo-video'))
  const film = await submit(vid, 'video', { assets: [picks.image] })
  const map = {
    auth: 'x-api-key',
    submit: 'mapped',
    poll: 'status/{id}',
    body: '{"request":{"duration":"{{seconds}}","tag":"镜头：{{prompt}}"}}',
    id: 'ref.id',
    state: 'task.stage',
    url: 'task.result',
    base64: '',
    error: 'err',
    waiting: 'queue',
    success: 'ready',
    failure: 'error',
    sizes: ['16:9'],
    seconds: [7],
  }
  const mapped = await record({
    ...profile('relay-video', 'demo-map'),
    relay: map,
  })
  await submit(mapped, 'video', {
    size: '16:9',
    seconds: 7,
    prompt: '保持 {{size}}',
  })
  const customImage = await record({
    ...profile('relay-image', 'demo-map'),
    relay: {
      ...map,
      submit: 'custom-image',
      poll: '',
      url: 'outputs.0.picture',
    },
  })
  await submit(customImage, 'image', { size: '16:9' })
  for (const [protocol, size] of [
    ['wan-image', '2048x2048'],
    ['wan-video', '1280x720'],
    ['ark-video', '16:9'],
  ]) {
    const id = await record(profile(protocol, 'demo-legacy'))
    await submit(id, protocol.split('-')[1], { size, seconds: 5 })
  }
  for (const kind of ['image', 'video']) {
    const id = await record(profile('rh-' + kind, 'demo-site'))
    for (const t of templates.filter((t) => t.Video === (kind === 'video'))) {
      const assets = t.Slots.flatMap((s) =>
        Array.from({ length: s.Min }, () => picks[s.Kind]),
      )
      if (!assets.length && t.AnyReference) assets.push(picks.image)
      await submit(id, kind, {
        template: t.Key,
        config: Object.fromEntries(t.Fields.map((f) => [f.Key, f.Default])),
        priority: t.Rate === t.FastRate ? 0 : 1,
        prompt: t.Text ? '模板回归' : '',
        assets,
      })
    }
  }
  assert.equal(requests.filter((x) => x === 'POST /v1/tasks/create').length, 12)
  assert.ok(requests.includes('put'))
  assert.deepEqual(errors, [])
  await page.getByRole('button', { name: '作品库', exact: true }).click()
  await page.getByLabel('筛选作品').selectOption('video')
  const card = page
    .locator('.card')
    .filter({ has: page.locator('small', { hasText: 'openai-video' }) })
  await card.dblclick()
  await page.waitForFunction(
    () => document.querySelector('.canvas video')?.readyState >= 1,
  )
  const dims = await page.locator('.canvas video').evaluate(async (el) => {
    el.muted = true
    await el.play()
    return [el.videoWidth, el.videoHeight]
  })
  assert.deepEqual(dims, [96, 64])
  assert.equal(
    (await state()).jobs.find((x) => x.id === film.id).status,
    'done',
  )
  const extra = await exerciseCreation({
    page,
    state,
    record,
    submit,
    done,
    pick,
    picks,
    profile,
    map,
    base,
    temp,
    png,
    mock: matrix,
    shot,
    templates,
  })
  await exerciseWorkspace({ page, base, oldId, shot, state, mock: workspace })
  await stop()
  await delay(500)
  await start()
  assert.equal(await page.getByLabel('生成服务').inputValue(), '@site')
  await page.getByRole('button', { name: '视频', exact: true }).click()
  assert.equal(await page.getByLabel('生成服务').inputValue(), '@site')
  assert.equal((await state()).jobs.length, 21 + extra)
  await page.getByRole('button', { name: '剧本', exact: true }).click()
  await page.getByRole('heading', { name: '渡口，日出之前' }).waitFor()
  const settings = await page.evaluate(() => window.studio.settings())
  assert.ok(settings.writer.hasKey && settings.hasStorageKey && settings.storage.automatic)
  assert.equal(settings.writer.model, 'studio-writer-from-list')
  console.log('Screenplay editing, scene handoff, manual and automatic signed uploads, retry and restart passed')
  assert.deepEqual(errors, [])
  console.log(
    'Packaged IPC, 12 RH submissions, 7 third-party protocols, restart, scoped credentials and native video playback passed',
  )
} finally {
  await stop()
  await closeServer(files)
  await closeServer(relay)
  await rm(temp, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 250,
  }).catch(() => {})
}
