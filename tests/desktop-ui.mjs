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
import { comfyFixture, exerciseComfy, seedGallery, exerciseGallery } from './studio-24.mjs'
import { exerciseLibraryLayout } from './library-layout.mjs'
import { exerciseImageMenu, exerciseVideoMenu } from './library-menu.mjs'
import { backgroundFixture, exerciseBackgroundTasks } from './background-tasks.mjs'
import { shotFixture, exerciseTwoShots } from './two-shot-workspace.mjs'
import { exerciseOptimizer, optimizerFixture } from './prompt-optimizer.mjs'
import { exerciseGenerationOptimization, generationFixture } from './generation-optimization.mjs'
import { exerciseTaskHelp, taskHelpFixture } from './task-guidance.mjs'
import { exerciseRoadmap } from './project-roadmap.mjs'
import { exerciseDelivery } from './delivery-specs.mjs'
import { templateFixture, exerciseTemplates, exerciseCommunityFile } from './prompt-templates.mjs'
import { agentFixture, exerciseAgent, exerciseLiveAgent, prepareLiveWriter } from './prompt-agent.mjs'
import { exerciseLiveMedia } from './media-live.mjs'
import { waitForValue } from './wait-for-value.mjs'
import { exerciseConnectionGroups, legacyRelay } from './connection-groups.mjs'
import { exerciseWriterConnections, writerRelayFixture } from './writer-connections.mjs'
import { exerciseMaximizedScript, exerciseResponsiveLayout } from './responsive-layout.mjs'
import { exerciseScriptWriting } from './script-writing.mjs'
import { exerciseScriptProgress, scriptProgressFixture } from './script-progress.mjs'
import { exerciseLifecycle, lifecycleFixture } from './window-lifecycle.mjs'
import { exampleFixture, exerciseExamples } from './request-examples.mjs'

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
let keepPaidTestHome = false

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
async function restartNormally(quit = () => page.evaluate(() => { void window.studio.requestQuit() })) {
  const exiting = once(child, 'exit')
  const requested = Promise.race([quit(), exiting]).then(() => exiting)
  await Promise.race([requested, delay(15000, null, { ref: false }).then(() => { throw Error('Application did not exit after flushing drafts') })])
  await stop()
  await start()
  return page
}
async function start() {
  const webview = await mkdtemp(path.join(temp, 'WebView-'))
  let endpoint = '', uiReady = false
  child = spawn(exe, [], {
    cwd: temp,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      MOBIUS_HOME: data,
      MOBIUS_SMOKE_TEST: '1',
      WEBVIEW2_USER_DATA_FOLDER: webview,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        '--remote-debugging-address=127.0.0.1 --remote-debugging-port=0',
    },
  })
  child.stderr.on('data', chunk => { if (chunk.toString().includes('MOBIUS_WEBVIEW_READY')) uiReady = true })
  let targets = []
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null)
      throw Error(
        'QA instance exited before providing a WebView. Close other Tauri copies first.',
      )
    try {
      if (!endpoint) {
        const activePort = await readFile(path.join(webview, 'EBWebView', 'DevToolsActivePort'), 'utf8')
        const port = Number(activePort.split(/\r?\n/, 1)[0])
        if (Number.isInteger(port) && port > 0 && port <= 65535) endpoint = 'http://127.0.0.1:' + port
      }
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
    'Packaged WebView target unavailable. Native UI ready: ' + uiReady + ', debug port discovered: ' + Boolean(endpoint),
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
  await page.getByLabel('生成服务', { exact: true }).waitFor()
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
async function shot(name, target = page) {
  if (captures) {
    await mkdir(captures, { recursive: true })
    await target.screenshot({ path: path.join(captures, name + '.png') })
  }
}

async function checkBackdrop(moving) {
  const layer = page.locator('.preview-flow[aria-hidden="true"]')
  await layer.waitFor()
  await page.waitForFunction(expected => {
    const layer = document.querySelector('.preview-flow')
    return layer && ['::before', '::after'].every(pseudo =>
      (getComputedStyle(layer, pseudo).animationName !== 'none') === expected)
  }, moving)
  if (moving) {
    const pose = await layer.evaluate(el => getComputedStyle(el, '::before').transform)
    await page.waitForFunction(previous =>
      getComputedStyle(document.querySelector('.preview-flow'), '::before').transform !== previous, pose)
  }
}

async function run() {
  for (const dir of ['tasks', '作品'])
    await mkdir(path.join(data, dir), { recursive: true })
  // Run with an isolated test build whose version is below the published stable release.
  if (process.argv.includes('--startup-update-live')) {
    await start()
    const notice = () => page.getByRole('region', { name: '软件更新提醒' })
    const button = name => page.getByRole('button', { name, exact: true })
    await notice().waitFor({timeout: 30000})
    const latest = (await notice().getByRole('status').innerText()).match(/\d+\.\d+\.\d+/)[0]
    await page.locator('#prompt').fill('启动检查不影响创作')
    await shot('启动更新提醒', notice())
    await button('稍后提醒').click()
    await notice().waitFor({state:'hidden'})
    assert.equal(await page.locator('#prompt').inputValue(), '启动检查不影响创作')
    await restartNormally()
    await notice().waitFor({timeout: 30000})
    await button('跳过此版本').click()
    await notice().waitFor({state:'hidden'})
    assert.equal(JSON.parse(await readFile(path.join(data,'settings.json'), 'utf8')).skippedUpdateVersion, latest)
    await restartNormally()
    assert.equal(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('check_app_update',{startup:true})), null)
    assert.equal(await notice().count(), 0)
    await button('设置').click()
    await button('软件更新').click()
    await button('检查更新').click()
    await page.getByText('发现新版本 ' + latest, {exact:true}).waitFor({timeout:30000})
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('skip_app_update',{version:'0.0.1'}))
    await restartNormally()
    await notice().waitFor({timeout:30000})
    await button('立即更新').click()
    await button('退出并安装').waitFor({timeout:305000})
    await page.getByText('更新包已通过 SHA-256 校验，可以安装。',{exact:true}).waitFor()
    assert.deepEqual(errors, [])
    console.log('Startup notice, later, persisted skip, manual override, later release and verified download passed:', latest)
    return
  }
  if (process.argv.includes('--update-live')) {
    await start()
    const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version
    const button = name => page.getByRole('button', { name, exact: true })
    await button('设置').click()
    await button('软件更新').click()
    await page.getByText('当前版本 ' + version, { exact: true }).waitFor()
    await button('检查更新').click()
    const result = page.locator('.preferences-content h3[role="status"]')
    await result.waitFor({ timeout: 30000 })
    console.log('Installed updater:', version, await result.innerText())
    await shot('检查更新', page.locator('.preferences-content'))
    assert.deepEqual(errors, [])
    return
  }
  if (process.argv.includes('--script-progress-only')) {
    const fixture = scriptProgressFixture()
    relay = await listen(fixture.handle)
    await start()
    await exerciseScriptProgress({page, base:origin(relay) + '/v1', fixture, shot, restart:restartNormally})
    assert.deepEqual(errors, [])
    return
  }
  if (process.argv.includes('--script-writing-only')) {
    await start()
    await exerciseScriptWriting({ page, shot })
    assert.deepEqual(errors, [])
    return
  }
  if (process.argv.includes('--lifecycle-only')) {
    const fixture = lifecycleFixture(png)
    relay = await listen(fixture.handle)
    await start()
    try { await exerciseLifecycle({ page, data, base: origin(relay)+'/v1', currentPid: () => child.pid, fixture, restart: restartNormally, shot }) }
    finally { fixture.release.resolve() }
    assert.deepEqual(errors, [])
    return
  }
  if (process.argv.includes('--responsive-only')) {
    await seedGallery(data)
    await start()
    await exerciseResponsiveLayout({ page, shot })
    await exerciseMaximizedScript({ page: await restartNormally(), shot })
    assert.deepEqual(errors, [])
    return
  }
  if (process.argv.includes('--writer-connections-only')) {
    const fixture = writerRelayFixture()
    relay = await listen(fixture.handle)
    await start()
    await exerciseWriterConnections({ page, base: origin(relay) + '/v1', restart: restartNormally, shot, fixture })
    assert.deepEqual(errors, [])
    return
  }
  if (process.argv.includes('--connection-groups-only')) {
    const videoFile = path.join(temp, 'relay-output.mp4')
    const sample = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=96x64:d=1',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-threads', '1', videoFile])
    assert.equal(sample.status, 0, 'Fixture video requires FFmpeg')
    const video = await readFile(videoFile)
    relay = await listen((req, res, bytes) => {
      assert.equal(req.headers.authorization, 'Bearer local-relay-test')
      if (req.url === '/v1/models') return json(res, {data: [{id: 'relay-movie'}]})
      if (req.url === '/v1/videos' && req.method === 'POST') {
        assert.match(bytes.toString(), /name="model"\r\n\r\nrelay-movie-alt\r\n/)
        return json(res, {id: 'clip'})
      }
      if (req.url === '/v1/videos/clip') return json(res, {status: 'completed'})
      if (req.url === '/v1/videos/clip/content') return res.end(video)
      if (req.url === '/v1/images/generations' && req.method === 'POST') {
        const body = JSON.parse(bytes)
        assert.equal(body.model, legacyRelay.Model)
        assert.equal(body.size, body.prompt === '2K' ? '2048x2048' : '3840x2160')
        return json(res, {data: [{b64_json: png.toString('base64')}]})
      }
      assert.fail('Unexpected fixture request')
    })
    await writeFile(path.join(data, 'connections.json'), JSON.stringify([legacyRelay]))
    await start()
    await exerciseConnectionGroups({ page, restart: restartNormally, shot, base: origin(relay) + '/v1' })
    assert.deepEqual(errors, [])
    return
  }
  if (process.argv.includes('--media-live')) {
    keepPaidTestHome=true
    await start()
    await exerciseLiveMedia({page,data,templates,profilesFile:process.env.MOBIUS_LIVE_MEDIA_PROFILES,output:process.env.MOBIUS_LIVE_MEDIA_OUTPUT})
    keepPaidTestHome=false
    assert.deepEqual(errors,[])
    return
  }
  if (process.argv.includes('--community-templates')) {
    await start()
    await exerciseCommunityFile(page,process.env.MOBIUS_COMMUNITY_CSV)
    assert.deepEqual(errors, [])
    return
  }
  if (process.argv.includes('--agent-live')) {
    await prepareLiveWriter(data, process.env.MOBIUS_LIVE_WRITER_SETTINGS)
    await start()
    await exerciseLiveAgent(page, restartNormally)
    assert.deepEqual(errors, [])
    return
  }
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
  if (process.argv.includes('--developer-only')) {
    const fixture = exampleFixture(png)
    relay = await listen(fixture.handle)
    await start()
    await exerciseExamples({page, base:origin(relay)+'/v1', temp, png, templates, fixture, done, record, restart:restartNormally, shot})
    assert.deepEqual(errors,[])
    return
  }
  if (process.argv.includes('--library-layout-only')) {
    await seedGallery(data)
    await start()
    await exerciseLibraryLayout(page)
    assert.deepEqual(errors, [])
    return
  }
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
  if (process.argv.includes('--library-menu-only')) {
    const videoId = 'b'.repeat(32)
    await writeFile(path.join(data, '作品', 'clip.mp4'), video)
    await writeFile(path.join(data, 'tasks', videoId + '.json'), JSON.stringify({
      Id: videoId, ProfileId: 'legacy', ProfileName: '旧版', ProtocolId: 'openai-video',
      BaseUrl: 'https://relay.example/v1', Model: 'test-video', Prompt: '测试视频作品',
      Status: 'done', FileName: 'clip.mp4', CreatedUtc: '/Date(1780000001000)/',
    }))
    await start()
    await page.getByRole('button', { name: '作品库', exact: true }).click()
    await exerciseImageMenu(page)
    await exerciseVideoMenu(page, videoId)
    assert.deepEqual(errors, [])
    console.log('Image and video context menus passed with mouse, keyboard, transient focus loss, and the original work IDs.')
    return
  }
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
  const comfy = comfyFixture(png)
  const background = backgroundFixture(clip, still)
  const twoShots = shotFixture(temp)
  const optimizer = optimizerFixture(png)
  const agent = agentFixture()
  const promptTemplates = templateFixture()
  const generation = generationFixture(png, clip)
  const help = taskHelpFixture(png, video)
  const deliveryCalls = []
  const waitingMedia = { 'wan-image': Promise.withResolvers(), 'wan-video': Promise.withResolvers() }
  let imageChecks = 0, videoChecks = 0
  relay = await listen(async (req, res, bytes) => {
    if (req.url === '/delivery/v1/tasks/create') {
      assert.equal(req.headers['x-auth-token'], 'delivery-fixture')
      deliveryCalls.push(JSON.parse(bytes.toString()))
      return json(res, { code: 200, data: { task_id: 'delivery-' + deliveryCalls.length } })
    }
    if (req.url.startsWith('/delivery/v1/tasks/delivery-')) {
      return json(res, { code: 200, data: { status: 'completed', result_oss_url: still } })
    }
    if (await help.handle(req, res, bytes)) return
    if (await generation.handle(req, res, bytes)) return
    if (promptTemplates.handle(req,res,bytes)) return
    if (await agent.handle(req, res, bytes)) return
    if (await optimizer.handle(req, res, bytes)) return
    if (await twoShots.handle(req, res, bytes)) return
    if (background.handle(req, res, bytes)) return
    if (comfy.handle(req, res, bytes)) return
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
    if (url === '/v1/tasks/wan-image') {
      imageChecks++
      if (imageChecks === 1) { res.writeHead(503); return res.end('{}') }
      if (imageChecks === 2) return json(res, { output: { task_status: 'RUNNING' } })
      await waitingMedia['wan-image'].promise
      return json(res, {
        output: { task_status: 'SUCCEEDED', results: [{ url: still }] },
      })
    }
    if (url === '/v1/tasks/wan-video') {
      if (++videoChecks === 1) return json(res, { output: { task_status: 'PENDING' } })
      await waitingMedia['wan-video'].promise
      return json(res, {
        output: { task_status: 'SUCCEEDED', video_url: clip },
      })
    }
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
  const checkShots = () => exerciseTwoShots({ page, base, fixture: twoShots, record, state, shot, restart: restartNormally })
  const checkOptimizer = () => exerciseOptimizer({ page, base, fixture: optimizer, record, shot, restart: restartNormally,
    referenceFile: path.join(data, '作品', 'old.png') })
  const checkAgent = () => exerciseAgent({ page, base, fixture: agent, restart: restartNormally, referenceFile: path.join(data, '作品', 'old.png') })
  const checkTemplates = () => exerciseTemplates({page,base,fixture:promptTemplates,data,restart:restartNormally})
  if (process.argv.includes('--templates-only')) { await checkTemplates(); assert.deepEqual(errors, []); return }
  if (process.argv.includes('--agent-only')) { await checkAgent(); assert.deepEqual(errors, []); return }
  const checkGeneration = () => exerciseGenerationOptimization({ page, base, fixture: generation, record, state, done, shot,
    restart: restartNormally, firstFrame: path.join(data, '作品', 'old.png'), lastFrame: path.join(root, 'src', 'orbit.png'), video,
    processingTemplate: templates.find(t => t.Video && !t.Text).Key })
  const checkHelp = () => exerciseTaskHelp({ page, base, fixture: help, record, state, done, shot, restart: restartNormally, video })
  const checkDelivery = () => exerciseDelivery({ data, restart: restartNormally, shot, record, base, calls: deliveryCalls, templates, done })
  const checkRoadmap=()=>exerciseRoadmap({page,data,temp,png,video,templates,restart:restartNormally})
  if (process.argv.includes('--background-only')) {
    await exerciseBackgroundTasks({page, base, fixture:background, record, state, done, shot, restart:restartNormally, png, video})
    assert.deepEqual(errors, [])
    return
  }
  if(process.argv.includes('--comfy-only')) {await exerciseComfy({page,base,done,shot,fixture:comfy});return}
  if(process.argv.includes('--roadmap-only')) {await checkRoadmap();return}
  if (process.argv.includes('--delivery-only')) {
    await checkDelivery()
    assert.deepEqual(errors, [])
    return
  }
  if (process.argv.includes('--help-only')) {
    await checkHelp()
    assert.deepEqual(errors, [])
    return
  }
  if (process.argv.includes('--generation-only')) {
    await checkGeneration()
    assert.deepEqual(errors, [])
    return
  }
  if (process.argv.includes('--prompt-only')) {
    await checkOptimizer()
    assert.deepEqual(errors, [])
    return
  }
  if (process.argv.includes('--shots-only')) {
    await checkShots()
    assert.deepEqual(errors, [])
    return
  }
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
  // Both clicks must land on the card even when the first click reveals selection tools.
  await page.locator('.card').dblclick({ position: { x: 18, y: 12 }, delay: 60 })
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
  await page.getByRole('button', { name: '作品库', exact: true }).click()
  await page.locator('.card img').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '图生视频' }).waitFor()
  await shot('作品库右键')
  await page.keyboard.press('Escape')
  await page.locator('.card').press('Shift+F10')
  await page.getByRole('menuitem', { name: '图生视频' }).click()
  await page.getByRole('img', { name: '视频首帧预览' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '视频', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.match(await page.locator('.file-row').innerText(), /old.png/)
  assert.equal((await state()).jobs.length, 1)
  await page.getByRole('button', { name: '图片', exact: true }).click()
  await page.getByRole('button', { name: '管理模型连接' }).click()
  await page.getByRole('button', { name: '添加模型服务' }).click()
  let dialog = page.getByRole('dialog')
  await dialog.getByLabel('连接名称').fill('测试图片')
  await dialog.getByLabel('服务分组').selectOption('relay')
  await dialog.getByLabel('服务根地址').fill(new URL(base).origin)
  await dialog.getByLabel('API Key').fill('demo-image')
  await dialog.getByRole('button', { name: '获取模型列表' }).click()
  await dialog.getByLabel('从服务商选择模型').selectOption('local-image')
  await dialog.getByText('同一连接的其他模型', { exact: true }).click()
  await dialog.getByLabel('从列表加入备选模型').selectOption('local-image-fast')
  await dialog.getByRole('button', { name: '保存连接' }).click()
  const savedConnection = page.getByRole('region', { name: '中转站与自定义接口' }).getByRole('article', { name: '测试图片' })
  await savedConnection.waitFor()
  assert.deepEqual(await savedConnection.getByRole('list', { name: '图片模型' }).locator('code').allTextContents(), ['local-image', 'local-image-fast'])
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
  await waitForValue(async () =>
    (await state()).jobs.some(
      (j) => j.prompt === '自定义中转站图片' && j.model === 'local-image-fast' && j.status === 'done',
    ), 'the selected relay model to finish generating its image')
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
  const keyless = await record({ ...profile('rh-video', ''), name: '待配置的视频连接' })
  for (const unavailable of [mapped, keyless]) {
    await page.getByRole('button', { name: '视频', exact: true }).click()
    await service.selectOption(unavailable)
    await page.getByRole('button', { name: '作品库', exact: true }).click()
    const legacyCard = page.locator('.work-card').filter({ hasText: '旧版测试作品' })
    const previousCount = (await state()).jobs.length
    await legacyCard.getByRole('button', { name: '图生视频' }).click()
    await page.getByRole('img', { name: '视频首帧预览' }).waitFor()
    assert.equal(await service.inputValue(), vid)
    assert.equal(await page.getByLabel('创作方式').inputValue(), 'first_frame')
    assert.match(await page.locator('.file-row').innerText(), /old.png/)
    assert.equal((await state()).jobs.length, previousCount)
  }
  for (const [protocol, size] of [
    ['wan-image', '2048x2048'],
    ['wan-video', '1280x720'],
    ['ark-video', '16:9'],
  ]) {
    const id = await record(profile(protocol, 'demo-legacy'))
    if (protocol in waitingMedia) {
      const media = protocol === 'wan-image' ? '图片' : '视频'
      await page.getByRole('button', { name: media, exact: true }).click()
      await service.selectOption(id)
      await prompt.fill('山脊的晨雾缓慢散开，远处透出第一线日光')
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await page.getByRole('button', { name: '生成' + media, exact: true }).click()
      try {
        await page.getByRole('heading', { name: '正在生成' + media }).waitFor()
        assert.equal(await page.locator('.preview-stages [aria-current=step]').innerText(), '模型生成')
        await checkBackdrop(true)
        const timer = page.getByRole('timer')
        assert.match(await timer.innerText(), /已用时\s+\d+:\d{2}/)
        if (media === '图片') {
          await page.locator('.job-preview').getByText('服务商暂时不可用', { exact: true }).waitFor()
          const guidance = page.getByRole('group', { name: '处理建议' })
          await guidance.getByText(/倒计时结束后会自动重查同一任务/).waitFor()
          assert.match(await guidance.locator('details').textContent(), /进度查询暂时中断.*HTTP 503/)
          await timer.getByText(/后重试/).waitFor()
          await shot('查询自动重试')
          await page.getByText('服务商正在生成。', { exact: true }).waitFor()
          assert.doesNotMatch(await timer.innerText(), /重试/)
          await shot('图片生成中')
          await page.emulateMedia({ reducedMotion: 'reduce' })
          await checkBackdrop(false)
        } else {
          await page.getByText('服务商已接收，等待处理。', {exact:true}).waitFor()
          await shot('视频生成中')
          await page.getByRole('button', { name: '作品库', exact:true }).click()
          await page.getByLabel('任务状态').selectOption('active')
          await page.getByLabel('筛选作品').selectOption('video')
          assert.equal(await page.locator('.work-card').count(), 1)
          await page.locator('.work-card .card').dblclick()
          await page.getByRole('heading', {name:'正在生成视频'}).waitFor()
          await page.getByRole('button', { name: '作品库', exact:true }).click()
          await page.getByLabel('任务状态').selectOption('all')
          await page.getByRole('button', { name: '创作台', exact:true }).click()
          for (const mode of ['eco', 'auto']) {
            await page.getByRole('button', { name: '设置', exact: true }).click()
            await page.getByRole('button', { name: '性能', exact: true }).click()
            await page.getByLabel('性能模式').selectOption(mode)
            await page.waitForFunction(m => document.querySelector('.shell').dataset.performance === m, mode)
            await page.getByRole('button', { name: '创作台', exact: true }).click()
            await checkBackdrop(mode === 'auto')
          }
        }
      } finally {
        waitingMedia[protocol].resolve()
        await page.emulateMedia({ reducedMotion: null })
      }
      await page.waitForFunction(isImage => isImage
        ? document.querySelector('.canvas img[alt="作品预览"]')?.naturalWidth === 1
        : document.querySelector('.canvas video')?.readyState >= 1, media === '图片')
      assert.equal(await page.locator('.preview-flow').count(), 0)
      assert.equal(await page.getByRole('timer').count(), 0)
    } else await submit(id, protocol.split('-')[1], { size, seconds: 5 })
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
  await card.scrollIntoViewIfNeeded()
  await card.locator('img').waitFor({timeout: 15000})
  const poster = await page.evaluate(id => window.__TAURI_INTERNALS__.invoke('video_poster', {id}), film.id)
  assert.ok(poster.path?.endsWith('.png'), 'The video frame should become a reusable disk thumbnail')
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
  await exerciseComfy({ page,base,done,shot,fixture:comfy })
  await exerciseWorkspace({ page, base, oldId, shot, state, mock: workspace })
  await stop()
  const oldTask = JSON.parse(await readFile(path.join(data, 'tasks', oldId + '.json'), 'utf8'))
  const previewCases = [
    ['b'.repeat(32), '文件丢失用例', 'done', 'missing.png', '找不到本地原文件'],
    ['c'.repeat(32), '读取失败用例', 'done', 'broken.png', '图片预览未能打开'],
    ['d'.repeat(32), '生成失败用例', 'failed', null, '图片生成失败'],
  ]
  await writeFile(path.join(data, '作品', 'broken.png'), 'invalid image fixture')
  await seedGallery(data)
  for (const [Id, Prompt, Status, FileName] of previewCases) {
    await writeFile(path.join(data, 'tasks', Id + '.json'), JSON.stringify({ ...oldTask, Id, Prompt, Status, FileName, Cloud: null }))
  }
  await delay(500)
  await start()
  assert.equal(await page.getByLabel('生成服务').inputValue(), '@site')
  await page.getByRole('button', { name: '视频', exact: true }).click()
  assert.equal(await page.getByLabel('生成服务').inputValue(), '@site')
  assert.equal((await state()).jobs.length, 21 + extra + previewCases.length + 2 + 120)
  for (const [, name, , , heading] of previewCases) {
    await page.getByRole('button', { name: '作品库', exact: true }).click()
    await page.locator('.card').filter({ hasText: name }).dblclick()
    await page.getByRole('heading', { name: heading }).waitFor()
    assert.equal(await page.locator('.preview-stages').count(), 0)
    assert.equal(await page.locator('.preview-flow').count(), 0)
  }
  await page.getByRole('button', { name: '剧本', exact: true }).click()
  await page.getByRole('heading', { name: '渡口，日出之前' }).waitFor()
  const settings = await page.evaluate(() => window.studio.settings())
  assert.ok(settings.writer.hasKey && settings.hasStorageKey && settings.storage.automatic)
  assert.equal(settings.writer.model, 'studio-writer-from-list')
  await page.getByText(/^关联作品 · /).first().click()
  await page.getByRole('button',{name:'已定稿',exact:true}).waitFor()
  await page.getByRole('button',{name:'设置',exact:true}).click()
  await page.getByRole('button',{name:'性能',exact:true}).click()
  await page.getByLabel('性能模式').selectOption('performance')
  await page.getByText('性能设置已保存。',{exact:true}).waitFor()
  await shot('性能设置')
  await exerciseGallery({page,shot})
  await exerciseLibraryLayout(page)
  await page.getByRole('button',{name:'设置',exact:true}).click()
  await page.getByLabel('性能模式').selectOption('eco')
  await page.waitForFunction(()=>document.querySelector('.shell')?.dataset.performance==='eco')
  await stop()
  await start()
  await page.getByRole('button',{name:'设置',exact:true}).click()
  await page.getByRole('button',{name:'性能',exact:true}).click()
  assert.equal(await page.getByLabel('性能模式').inputValue(), 'eco')
  await exerciseBackgroundTasks({ page, base, fixture: background, record, state, done, shot, png, video,
    restart: async () => { await stop(); await start(); return page } })
  console.log('Screenplay editing, scene handoff, manual and automatic signed uploads, retry and restart passed')
  console.log('Packaged IPC, 12 RH submissions, third-party protocols, scoped credentials and native video playback passed')
  await exerciseScriptWriting({ page, shot })
  await checkShots()
  await checkOptimizer()
  await checkGeneration()
  await checkHelp()
  await checkDelivery()
  await checkRoadmap()
  await checkAgent()
  await checkTemplates()
  assert.deepEqual(errors, [])
}
try {
  await run()
} finally {
  await stop()
  await closeServer(files)
  await closeServer(relay)
  if (keepPaidTestHome) console.log('Paid test data retained at '+temp)
  else await rm(temp, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 250,
  }).catch(() => {})
}
