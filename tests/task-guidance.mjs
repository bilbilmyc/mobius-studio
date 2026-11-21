import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const syncPrompt = '等候海面全景'
const movie = '雨棚下推近的镜头'
const rejectedMovie = '服务商终止的镜头'

export function taskHelpFixture(png, video) {
  const gate = Promise.withResolvers()
  const fixture = { gate, phase: 'waiting', allowDownload: false, posts: [], queries: [], downloads: 0, writerCalls: 0,
    async handle(req, res, bytes) {
      if (!req.url.startsWith('/help-')) return false
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
      }
      const auth = req.headers.authorization
      const body = bytes.length ? JSON.parse(bytes.toString()) : {}
      if (req.url === '/help-writer/v1/chat/completions') {
        fixture.writerCalls++
        send(403, { error: { message: 'project access denied' } })
      } else if (req.url === '/help-image/v1/models') {
        if (auth === 'Bearer help-image-ok') send(200, { data: [{ id: 'harbor-image' }] })
        else send(401, { error: { code: 'invalid_api_key', message: 'rejected help-image-bad' } })
      } else if (req.url === '/help-image/v1/images/generations') {
        fixture.posts.push(body.prompt)
        if (auth !== 'Bearer help-image-ok') send(401, { error: { message: 'rejected help-image-bad' } })
        else if (body.model !== 'harbor-image') send(404, { error: { code: 'model_not_found', message: 'unavailable' } })
        else if (body.prompt === syncPrompt) {
          await Promise.race([gate.promise, delay(25000, null, { ref: false })])
          send(504, { error: { message: 'gateway timeout' } })
        } else if (body.prompt === '额度用尽') send(429, { error: { code: 'insufficient_quota', message: 'billing limit' } })
        else send(200, { data: [{ b64_json: png.toString('base64') }] })
      } else if (req.url === '/help-video/v1/services/aigc/video-generation/video-synthesis') {
        assert.equal(auth, 'Bearer help-video-key')
        fixture.posts.push(body.input.prompt)
        send(200, { output: { task_id: body.input.prompt === movie ? 'rain-1' : 'rain-2' } })
      } else if (req.url.startsWith('/help-video/v1/tasks/')) {
        assert.equal(req.method, 'GET')
        fixture.queries.push(req.url)
        if (req.url.endsWith('rain-2')) send(200, { output: { task_status: 'FAILED', code: 'DataInspectionFailed', message: '素材需要调整' } })
        else if (fixture.phase === 'waiting') send(200, { output: { task_status: 'RUNNING' } })
        else if (fixture.phase === 'limited') {
          res.setHeader('Retry-After', '6')
          send(429, { message: 'rate limited' })
        } else if (fixture.phase === 'denied') send(401, { error: { code: 'invalid_api_key' } })
        else if (fixture.phase === 'unknown') send(200, { output: { task_status: 'UNKNOWN' } })
        else send(200, { output: { task_status: 'SUCCEEDED', video_url: 'http://' + req.headers.host + '/help-download.mp4' } })
      } else if (req.url === '/help-download.mp4') {
        assert.equal(auth, undefined)
        fixture.downloads++
        if (!fixture.allowDownload) send(403, { message: 'result expired' })
        else { res.setHeader('Content-Type', 'video/mp4'); res.end(video) }
      } else throw Error('Unexpected help fixture request ' + req.url)
      return true
    } }
  return fixture
}

export async function exerciseTaskHelp({ page, base, fixture, record, state, done, shot, restart, video }) {
  const root = new URL(base).origin
  const imageId = await record({ name: '海港图像服务', protocol: 'openai-image', model: 'wrong-model', key: 'help-image-bad', base: root + '/help-image/v1' })
  const videoId = await record({ name: '海港视频服务', protocol: 'wan-video', model: 'harbor-video', key: 'help-video-key', base: root + '/help-video/v1' })
  const optionalKey = await record({ name: '尚未填 Key 的连接', protocol: 'openai-image', model: 'optional-auth',
    key: '', base: 'https://models.example.invalid/v1' })
  await page.evaluate(async root => {
    const { storage } = await window.studio.settings()
    if (storage.automatic) await window.studio.saveStorage({ ...storage, automatic: false }, '')
    await window.studio.saveWriter({ base: root + '/help-writer/v1', model: 'text-only', key: 'help-writer-key' })
  }, root)
  await page.reload()
  const button = name => page.getByRole('button', { name, exact: true })
  const preview = () => page.locator('.job-preview')
  const guide = () => preview().locator('.task-guidance')
  const form = () => page.getByRole('dialog', { name: '编辑模型服务' })
  const prompt = () => page.locator('#prompt')
  async function job(text, status) {
    const until = Date.now() + 20000
    let found
    do {
      found = (await state()).jobs.find(j => j.prompt === text)
      if (found?.status === status) return found
      await delay(100)
    } while (Date.now() < until)
    throw Error('Expected ' + status + ' for ' + text + ', received ' + (found?.status ?? 'no record') + ' ' + (found?.detail ?? ''))
  }
  async function inspect(text, status) {
    const saved = await job(text, status)
    await button('后台任务').click()
    const panel = page.getByRole('dialog', { name: '后台任务' })
    await panel.getByRole('button', { name: /^全部 / }).click()
    await panel.locator('.task-row').filter({ has: page.getByText(text, { exact: true }) }).getByRole('button', { name: /查看/ }).click()
    await preview().waitFor()
    return saved
  }
  async function shiftPreviewClock(minutes) {
    await page.evaluate(minutes => {
      window.realTimeForHelpTest ??= Date.now
      Date.now = minutes ? () => window.realTimeForHelpTest() + minutes * 60000 : window.realTimeForHelpTest
    }, minutes)
  }
  async function submit(text, kind) {
    await prompt().fill(text)
    await button(kind === 'image' ? '生成图片' : '生成视频').click()
  }

  await button('使用帮助').click()
  const help = page.getByRole('dialog', { name: '使用帮助' })
  await help.getByText('图片或视频一直没有结果', { exact: true }).click()
  await help.getByText(/打开「后台任务 → 查看进度」/).waitFor()
  await shot('使用帮助')
  await help.getByRole('button', { name: '设置文本模型' }).click()
  assert.equal(await page.getByLabel('剧本模型 ID', { exact: true }).inputValue(), 'text-only')
  await button('创作台').click()
  await page.getByText(/当前生成服务还没有配置 Key/).waitFor()
  await page.getByLabel('生成服务').selectOption(optionalKey)
  await page.getByText(/这个连接还没有保存 API Key/).waitFor()
  assert.ok(await button('生成图片').isEnabled())
  await button('编辑当前连接').click()
  assert.equal(await form().getByLabel('连接名称').inputValue(), '尚未填 Key 的连接')
  await form().getByRole('button', { name: '取消' }).click()
  await prompt().fill('保留这份文本')
  await button('优化提示词').click()
  await button('开始优化').click()
  await page.getByRole('alert').filter({ hasText: '当前账户没有访问权限' }).waitFor()
  await button('检查模型配置').click()
  await page.getByLabel('剧本服务地址').waitFor()
  await button('创作台').click()
  assert.equal(await prompt().inputValue(), '保留这份文本')
  await page.getByLabel('生成服务').selectOption(imageId)

  await submit('钥匙失效', 'image')
  const denied = await inspect('钥匙失效', 'failed')
  assert.equal(denied.stoppedDuring, 'submitting')
  await preview().getByText('服务商未接受当前凭据').waitFor()
  await guide().getByText('技术详情').click()
  assert.ok((await guide().innerText()).includes('HTTP 401'))
  assert.ok(!(await guide().innerText()).includes('help-image-bad'))
  await button('检查生成服务').click()
  assert.equal(await form().getByLabel('连接名称').inputValue(), '海港图像服务')
  await form().getByRole('button', { name: '获取模型列表' }).click()
  await form().getByRole('alert').filter({ hasText: '服务商未接受当前凭据' }).waitFor()
  await form().getByLabel('API Key', { exact: true }).fill('help-image-ok')
  await form().getByRole('button', { name: '保存连接' }).click()
  await button('复用参数').click()
  await preview().waitFor({ state: 'hidden' })
  assert.equal(await prompt().inputValue(), '钥匙失效')
  await submit('模型拼错', 'image')
  await inspect('模型拼错', 'failed')
  await preview().getByText('所选模型不可用').waitFor()
  await button('检查生成服务').click()
  await form().getByRole('button', { name: '获取模型列表' }).click()
  await form().getByLabel('从服务商选择模型').selectOption('harbor-image')
  await form().getByRole('button', { name: '保存连接' }).click()
  await preview().getByRole('button', { name: '仅复用提示词' }).click()
  assert.equal(await prompt().inputValue(), '模型拼错')
  await submit('额度用尽', 'image')
  await inspect('额度用尽', 'failed')
  await preview().getByText('服务商账户额度不足').waitFor()
  await button('继续创作').click()

  await submit(syncPrompt, 'image')
  await inspect(syncPrompt, 'submitting')
  await shiftPreviewClock(3)
  await preview().getByText('仍在等待提交响应').waitFor()
  assert.equal(await preview().getByRole('button', { name: /继续查询|重新下载/ }).count(), 0)
  await shiftPreviewClock(0)
  fixture.gate.resolve()
  await job(syncPrompt, 'uncertain')
  await preview().getByText(/确认未受理后再生成/).waitFor()
  await shot('提交超时待核实')
  await page.evaluate(() => { window.studio.copyTaskInfo = async id => { window.copiedTestTask = id } })
  await button('复制排查信息').click()
  await guide().getByText('排查信息已复制。').waitFor()
  assert.equal(await page.evaluate(() => window.copiedTestTask), (await job(syncPrompt, 'uncertain')).id)

  await button('视频').click()
  await page.getByLabel('生成服务').selectOption(videoId)
  await submit(movie, 'video')
  const film = await inspect(movie, 'waiting')
  await preview().getByText('服务商正在生成。', { exact: true }).waitFor()
  await shiftPreviewClock(6)
  await preview().getByText('服务商有一段时间没有返回新进度').waitFor()
  await guide().getByText('rain-1', { exact: true }).waitFor()
  await shot('视频长时间等待')
  await shiftPreviewClock(0)
  fixture.phase = 'limited'
  await preview().getByText('服务商正在限流').waitFor()
  await preview().getByRole('timer').getByText(/后重试/).waitFor()
  const cooling = (await state()).jobs.find(j => j.id === film.id)
  assert.ok(cooling.retryAt > Date.now())
  fixture.phase = 'denied'
  await job(movie, 'paused')
  await preview().getByRole('button', { name: '继续查询原任务' }).waitFor()
  const firstRoundPosts = fixture.posts.length
  page = await restart()
  const restored = await inspect(movie, 'paused')
  assert.equal(restored.remoteId, 'rain-1')
  assert.equal(restored.stoppedDuring, 'waiting')
  assert.equal(fixture.posts.length, firstRoundPosts)
  fixture.phase = 'unknown'
  await button('继续查询原任务').click()
  await preview().getByText('服务商返回的状态暂时无法确认').waitFor()
  assert.equal((await job(movie, 'paused')).remoteId, 'rain-1')
  fixture.phase = 'ready'
  await button('继续查询原任务').click()
  await preview().getByRole('button', { name: '重新下载结果' }).waitFor()
  assert.equal(fixture.downloads, 1)
  const download = (await state()).jobs.find(j => j.id === film.id)
  assert.ok(download.hasResultUrl && download.stoppedDuring === 'downloading')
  await preview().getByText('结果文件暂时取不到').waitFor()
  await shot('原结果下载中断')
  fixture.allowDownload = true
  const oldQueries = fixture.queries.length
  await button('重新下载结果').click()
  const ready = await done(film.id)
  assert.ok((await readFile(ready.mediaPath)).equals(video))
  assert.equal(fixture.downloads, 2)
  assert.equal(fixture.queries.length, oldQueries)
  assert.equal(fixture.posts.length, firstRoundPosts)
  await button('视频').click()
  await page.getByLabel('生成服务').selectOption(videoId)
  await submit(rejectedMovie, 'video')
  await inspect(rejectedMovie, 'failed')
  await preview().getByText('服务商未通过内容审核').waitFor()
  assert.equal(await preview().getByRole('button', { name: /继续查询原任务|重新下载结果/ }).count(), 0)
  assert.equal(fixture.writerCalls, 1)
  assert.deepEqual(fixture.posts, ['钥匙失效', '模型拼错', '额度用尽', syncPrompt, movie, rejectedMovie])
  console.log('Task guidance passed: configuration repair, protected upstream errors, billing and policy, slow image/video, uncertain submit, cooldown, original-ticket resume and exact download after restart; no duplicate generation.')
}
