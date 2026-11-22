import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const coast = '清晨的海岸，薄雾笼罩灯塔'
const harbor = '保留参考图的构图，把港湾改成黄昏'
const voyage = '镜头跟随帆船穿过港口'
const draft = '下一镜草稿，海面上升起一轮月亮'

export function backgroundFixture(clip, still) {
  const tasks = new Map()
  const reply = (res, data) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(data))
  }
  return {
    tasks,
    handle(req, res, bytes) {
      if (!req.url.startsWith('/background/v1/')) return false
      assert.equal(req.headers.authorization, 'Bearer background-fixture')
      if (req.method === 'POST') {
        const body = JSON.parse(bytes)
        const video = body.model === 'harbor-video'
        const content = body.input.messages?.[0].content ?? []
        const prompt = video ? body.input.prompt : content.at(-1).text
        assert.ok(!tasks.has(prompt), 'a submitted job was posted twice')
        const id = 'background-' + (tasks.size + 1)
        tasks.set(prompt, { id, body, video, phase: 'running' })
        reply(res, { output: { task_id: id } })
      } else {
        const task = [...tasks.values()].find(t => req.url === '/background/v1/tasks/' + t.id)
        assert.ok(task, 'a poll used the wrong ticket')
        if (task.phase === 'paused') {
          res.writeHead(403)
          res.end('{}')
        } else if (task.phase === 'done') {
          reply(res, { output: { task_status: 'SUCCEEDED', ...(task.video ? { video_url: clip } : { results: [{ url: still }] }) } })
        } else reply(res, { output: { task_status: 'RUNNING' } })
      }
      return true
    },
  }
}

export async function exerciseBackgroundTasks({ page, base, fixture, record, state, done, shot, restart, png, video }) {
  const button = name => page.getByRole('button', { name, exact: true })
  const prompt = () => page.locator('#prompt')
  const panel = () => page.getByRole('dialog', { name: '后台任务' })
  const row = title => panel().getByRole('listitem').filter({ hasText: title })
  const holdNextSubmission = () => page.evaluate(() => {
    const start = window.studio.start
    window.studio.start = async input => {
      window.studio.start = start
      await new Promise(resolve => { window.releaseMediaSubmission = resolve })
      return start(input)
    }
  })
  async function count(expected) {
    try {
      await page.waitForFunction(n => document.querySelector('#task-count')?.textContent === String(n), expected)
    } catch (e) {
      const jobs = (await state()).jobs.filter(j => j.base.includes('/background/'))
      const notice = await page.locator('.status').innerText()
      throw Error('Expected ' + expected + ' active jobs. ' + notice + ' ' +
        JSON.stringify(jobs.map(j => [j.prompt, j.status, j.detail])), { cause: e })
    }
  }
  const viewDraft = async () => {
    assert.equal(await prompt().inputValue(), draft)
    assert.equal(await button('图片').getAttribute('aria-pressed'), 'true')
    assert.equal(await page.getByLabel('创作方式').inputValue(), 'i2i')
    assert.equal(await page.getByLabel('输出尺寸或画幅').inputValue(), '1024x1024')
    assert.match(await page.locator('.file-row').innerText(), /old\.png/)
  }
  const before = (await state()).jobs.length
  const settings = { base: new URL('/background/v1', base).href, key: 'background-fixture' }
  const imageService = await record({ ...settings, protocol: 'wan-image', name: '港湾图像', model: 'harbor-image' })
  const videoService = await record({ ...settings, protocol: 'wan-video', name: '港湾视频', model: 'harbor-video' })
  await button('创作台').click()
  await button('图片').click()
  await page.getByLabel('生成服务').selectOption(imageService)
  await page.getByLabel('输出尺寸或画幅').selectOption('2304x1728')
  await prompt().fill(coast)
  await holdNextSubmission()
  await button('生成图片').dblclick()
  await page.getByRole('heading', { name: '正在提交图片任务' }).waitFor()
  assert.equal(await page.locator('.canvas .sample-caption').count(), 0)
  await page.evaluate(() => window.releaseMediaSubmission())
  await count(1)
  assert.equal(await prompt().inputValue(), coast)
  await page.getByRole('heading', { name: '正在生成图片' }).waitFor()
  await shot('生图前台等待')
  const viewport = await page.evaluate(() => ({width:innerWidth, height:innerHeight}))
  await page.setViewportSize({width:320,height:420})
  await page.locator('.canvas').scrollIntoViewIfNeeded()
  assert.ok(await page.locator('.canvas .job-preview').evaluate(el => {
    const bounds = el.getBoundingClientRect()
    const action = el.querySelector('button').getBoundingClientRect()
    return el.scrollWidth <= el.clientWidth + 1 && action.top >= bounds.top && action.bottom <= bounds.bottom + 1
  }), 'the foreground action fits inside the narrow canvas')
  await shot('生图前台等待-320')
  await page.setViewportSize(viewport)
  await button('视频').click()
  assert.equal(await page.locator('.canvas .job-preview').count(), 0, 'a video draft must have its own canvas')
  await button('图片').click()
  await page.getByRole('heading', { name: '正在生成图片' }).waitFor()
  await button('转入后台').click()
  await page.locator('.job-preview').waitFor({ state: 'detached' })
  assert.equal(await prompt().inputValue(), coast)

  await page.getByLabel('创作方式').selectOption('i2i')
  await page.getByLabel('输出尺寸或画幅').selectOption('1024x1024')
  await button('作品库选图').click()
  await page.getByRole('dialog').getByRole('button', { name: /旧版测试作品/ }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.locator('.file-row').filter({ hasText: 'old.png' }).waitFor()
  await prompt().fill(harbor)
  await holdNextSubmission()
  await prompt().press('Control+Enter')
  await page.getByRole('heading', { name: '正在提交图片任务' }).waitFor()
  await prompt().dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, repeat: true, bubbles: true })
  await button('转入后台').click()
  await page.evaluate(() => window.releaseMediaSubmission())
  await count(2)
  assert.equal(await page.locator('.job-preview').count(), 0, 'acknowledgement must not reopen a backgrounded submission')
  await button('视频').click()
  await page.getByLabel('生成服务').selectOption(videoService)
  await page.getByLabel('时长（秒）').selectOption('10')
  await prompt().fill(voyage)
  await button('生成视频').click()
  await count(3)
  await page.getByRole('heading', { name: '正在生成视频' }).waitFor()
  await button('转入后台').click()
  await button('图片').click()
  await prompt().fill(draft)
  await button('设置').click()
  await button('后台任务').click()
  await panel().getByRole('button', { name: '进行中 3', pressed: true }).waitFor()
  for (const title of [coast, harbor, voyage]) await row(title).getByText('生成中', { exact: true }).waitFor()
  await shot('后台并行任务')
  const jobs = (await state()).jobs
  const submitted = [coast, harbor, voyage].map(title => jobs.find(j => j.prompt === title))
  assert.equal(jobs.length, before + 3)
  assert.equal(fixture.tasks.size, 3)
  for (const job of submitted) assert.equal(job.remoteId, fixture.tasks.get(job.prompt).id)
  assert.equal(fixture.tasks.get(coast).body.parameters.size, '2304*1728')
  assert.equal(fixture.tasks.get(coast).body.input.messages[0].content.length, 1)
  const referenced = fixture.tasks.get(harbor).body
  assert.equal(referenced.parameters.size, '1024*1024')
  assert.match(referenced.input.messages[0].content[0].image, /^data:image\/png;base64,/)
  assert.equal(fixture.tasks.get(voyage).body.parameters.duration, 10)

  await row(voyage).getByRole('button', { name: '查看进度' }).click()
  await page.getByRole('heading', { name: '正在生成视频' }).waitFor()
  await viewDraft()
  await button('转入后台').click()
  await page.waitForFunction(() => document.activeElement?.id === 'prompt')
  fixture.tasks.get(voyage).phase = 'done'
  const film = await done(submitted[2].id)
  assert.deepEqual(await readFile(film.mediaPath), video)
  await count(2)
  assert.equal(await page.locator('.canvas video, .job-preview').count(), 0)
  await viewDraft()

  fixture.tasks.get(harbor).phase = 'paused'
  await button('剧本').click()
  await count(1)
  await button('后台任务').click()
  await panel().getByRole('button', { name: /^待处理/ }).click()
  await row(harbor).getByText('待恢复', { exact: true }).waitFor()
  fixture.tasks.get(harbor).phase = 'done'
  await row(harbor).getByRole('button', { name: '恢复任务' }).click()
  const edited = await done(submitted[1].id)
  assert.deepEqual(await readFile(edited.mediaPath), png)
  await panel().getByRole('button', { name: /^已完成/ }).click()
  await row(voyage).getByRole('button', { name: '查看结果' }).waitFor()
  await row(harbor).getByRole('button', { name: '查看结果' }).waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('heading', { name: '剧本', exact: true }).waitFor()
  await button('创作台').click()
  await viewDraft()

  page = await restart()
  await count(1)
  await button('后台任务').click()
  await row(coast).getByRole('button', { name: '查看进度' }).waitFor()
  fixture.tasks.get(coast).phase = 'done'
  const original = await done(submitted[0].id)
  assert.deepEqual(await readFile(original.mediaPath), png)
  assert.notEqual(original.mediaPath, edited.mediaPath)
  await count(0)
  await panel().getByRole('button', { name: /^已完成/ }).click()
  await row(coast).getByRole('button', { name: '查看结果' }).click()
  await page.getByRole('img', { name: '作品预览', exact: true }).waitFor()
  assert.equal((await state()).jobs.length, before + 3)
  assert.equal(fixture.tasks.size, 3)
  console.log('Three concurrent UI submissions, isolated drafts and media, out-of-order completion, resume and restart without reposting passed')
}
