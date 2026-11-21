import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const imagePrompt = '雨后的码头，一把黄伞。'
const imageProposal = '雨后的码头上立着一把黄伞，木板上留着清晰的倒影。'
const framesPrompt = '从码头缓慢推向对岸。'
const framesProposal = '从首帧的码头平稳前推，靠近对岸时减速，落在尾帧的构图。'
const slowPrompt = '雾里的渡船。'
const fallbackPrompt = '固定镜头，一艘渡船驶离。'
const textVideoPrompt = '远处的渡船驶入晨雾。'
const textVideoProposal = '固定远景，渡船缓缓驶入晨雾，船尾的水纹渐渐消失。'

export function generationFixture(png, clip) {
  const writers = [], images = [], videos = []
  const slow = Promise.withResolvers(), started = Promise.withResolvers()
  function reply(res, body) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  }
  return { writers, images, videos, waiting: started.promise, release: slow.resolve, async handle(req, res, bytes) {
    if (!req.url.startsWith('/gen-')) return false
    const body = bytes.length ? JSON.parse(bytes.toString()) : null
    if (req.url === '/gen-writer/v1/chat/completions') {
      assert.equal(req.headers.authorization, 'Bearer gen-writer')
      assert.equal(body.model, '分镜编辑')
      const [system, original] = body.messages.map(m => m.content)
      writers.push({ system, original })
      if (original === slowPrompt) {
        started.resolve()
        await Promise.race([slow.promise, delay(25000, null, { ref: false })])
      }
      if (original === fallbackPrompt) {
        res.statusCode = 503
        reply(res, { error: { message: 'temporarily unavailable' } })
      } else {
        const content = new Map([[slowPrompt, '雾中的旧稿。'], [imagePrompt, imageProposal],
          [framesPrompt, framesProposal], [textVideoPrompt, textVideoProposal]]).get(original)
        assert.ok(content, 'Unexpected prompt to the writer')
        reply(res, { choices: [{ message: { content }, finish_reason: 'stop' }] })
      }
    } else if (req.url === '/gen-image/v1/images/generations') {
      assert.equal(req.headers.authorization, 'Bearer gen-image')
      images.push(body)
      reply(res, { data: [{ b64_json: png.toString('base64') }] })
    } else if (req.url.startsWith('/gen-video/v1/services/aigc/')) {
      assert.equal(req.headers.authorization, 'Bearer gen-video')
      const framed = body.model === '两帧视频'
      assert.equal(req.url, '/gen-video/v1/services/aigc/' + (framed ? 'image2video' : 'video-generation') + '/video-synthesis')
      videos.push(body)
      reply(res, { output: { task_id: 'clip-' + videos.length } })
    } else if (req.url.startsWith('/gen-video/v1/tasks/clip-')) {
      assert.equal(req.method, 'GET')
      reply(res, { output: { task_status: 'SUCCEEDED', video_url: clip } })
    } else throw Error('Unexpected generation endpoint ' + req.url)
    return true
  } }
}

export async function exerciseGenerationOptimization({ page, base, fixture, record, state, done, shot, restart,
  firstFrame, lastFrame, video, processingTemplate }) {
  const root = new URL(base).origin
  const title = '码头两镜'
  const script = await page.evaluate(async ({ root, title }) => {
    const { storage } = await window.studio.settings()
    if (storage.automatic) await window.studio.saveStorage({ ...storage, automatic: false }, '')
    await window.studio.saveWriter({ base: root + '/gen-unconfigured/v1', model: '分镜编辑', key: '' })
    return window.studio.createScript({ title, scenes: ['雨后码头', '渡船离岸'].map(heading =>
      ({ id: '', heading, action: heading, dialogue: '', imagePrompt: heading, videoPrompt: heading })) })
  }, { root, title })
  const imageId = await record({ name: '码头图片', base: root + '/gen-image/v1', protocol: 'openai-image',
    model: '画稿 A', models: ['画稿 B'], key: 'gen-image' })
  const videoProfile = { base: root + '/gen-video/v1', key: 'gen-video' }
  const framesId = await record({ ...videoProfile, name: '码头首尾帧', protocol: 'wan-frames-video', model: '两帧视频' })
  const textId = await record({ ...videoProfile, name: '码头文生视频', protocol: 'wan-video', model: '文字视频' })
  await page.reload()
  const button = name => page.getByRole('button', { name, exact: true })
  const mode = () => page.getByLabel('生成前优化', { exact: true }).filter({ visible: true })
  const prompt = () => page.locator('#prompt')
  const dialog = () => page.getByRole('dialog', { name: '生成前优化' })
  const proposal = () => dialog().getByLabel('优化稿', { exact: true })
  const service = () => page.getByLabel('生成服务')
  async function openScene(index, kind) {
    await button('剧本').click()
    await page.locator('.script-history button').filter({ hasText: title }).click()
    await page.locator('.shot-list > li').nth(index).getByRole('button', { name: kind === 'image' ? '用于生图' : '用于视频' }).click()
  }
  async function seeProposal(text) {
    await page.waitForFunction(value => document.querySelector('textarea[aria-label="优化稿"]')?.value === value, text)
  }
  async function checkJob(text, index) {
    const match = { text, sceneId: script.scenes[index].id }
    await page.waitForFunction(async ({ text, sceneId }) => (await window.studio.state()).jobs
      .some(j => j.prompt === text && j.shot?.sceneId === sceneId), match)
    const job = (await state()).jobs.find(j => j.prompt === text && j.shot?.sceneId === match.sceneId)
    return done(job.id)
  }
  async function pick(label, file) {
    await page.evaluate(file => {
      const original = window.studio.pick
      window.studio.pick = kind => { window.studio.pick = original; return window.studio.drop(kind, [file]) }
    }, file)
    await button(label).click()
  }

  await openScene(0, 'image')
  await service().selectOption(imageId)
  assert.equal(await mode().inputValue(), '')
  const direct = '正面拍摄的码头。'
  await prompt().fill(direct)
  await button('生成图片').click()
  await checkJob(direct, 0)
  assert.equal(fixture.writers.length, 0)
  assert.equal(fixture.images[0].prompt, direct)

  await mode().selectOption('polish')
  await prompt().fill(slowPrompt)
  await button('优化后生成图片').click()
  assert.equal(await dialog().getByLabel('优化原文').inputValue(), slowPrompt)
  await dialog().getByRole('button', { name: '配置剧本模型' }).click()
  await page.getByLabel('剧本服务地址').fill(root + '/gen-writer/v1')
  await page.getByLabel('剧本 API Key').fill('gen-writer')
  await page.getByLabel('剧本模型 ID', { exact: true }).fill('分镜编辑')
  await button('保存剧本模型').click()
  await page.getByText('设置已保存。', { exact: true }).waitFor()
  await button('创作台').click()
  assert.equal(await prompt().inputValue(), slowPrompt)
  assert.equal(fixture.writers.length, 0)
  await button('优化后生成图片').click()
  await button('收起').click()
  await Promise.race([fixture.waiting, delay(10000, null, { ref: false }).then(() => { throw Error('The first writer request did not arrive') })])
  await prompt().fill(imagePrompt)
  await button('优化后生成图片').click()
  await seeProposal(imageProposal)
  fixture.release()
  assert.equal(await dialog().getByLabel('优化原文').inputValue(), imagePrompt)
  const editedImage = imageProposal + ' 保留右侧空位。'
  await proposal().fill(editedImage)
  await shot('生图前优化')
  await button('关闭对照').click()
  assert.equal(await prompt().inputValue(), imagePrompt)
  assert.equal(fixture.images.length, 1)
  await button('优化后生成图片').click()
  await seeProposal(editedImage)
  await page.evaluate(() => {
    const start = window.studio.start
    window.studio.start = async () => { window.studio.start = start; throw Error('验收用入队错误') }
  })
  await button('采用并生成图片').click()
  await dialog().getByRole('alert').filter({ hasText: '验收用入队错误' }).waitFor()
  assert.equal(await prompt().inputValue(), imagePrompt)
  assert.equal(await proposal().inputValue(), editedImage)
  assert.equal(fixture.images.length, 1)
  await button('采用并生成图片').click()
  const imageJob = await checkJob(editedImage, 0)
  assert.equal(fixture.images[1].prompt, editedImage)
  assert.equal(fixture.images[1].size, imageJob.size)
  assert.equal(await prompt().inputValue(), editedImage)
  await page.getByLabel('对比模型', { exact: true }).selectOption(JSON.stringify([imageId, '画稿 B']))
  await button('优化后用两个模型生成').click()
  await seeProposal(editedImage)
  await button('采用并用两个模型生成').click()
  const pair = page.getByRole('dialog', { name: '双模型对比' })
  await pair.locator('img').nth(1).waitFor()
  assert.deepEqual(fixture.images.slice(2).map(j => j.model).sort(), ['画稿 A', '画稿 B'])
  assert.ok(fixture.images.slice(2).every(j => j.prompt === editedImage))
  assert.deepEqual(fixture.writers.map(w => w.original), [slowPrompt, imagePrompt])
  assert.match(fixture.writers[1].system, /润色原意/)
  assert.match(fixture.writers[1].system, /单张图片/)
  await pair.getByRole('button', { name: '关闭' }).click()

  await openScene(1, 'video')
  await service().selectOption(framesId)
  assert.equal(await mode().inputValue(), '')
  await mode().selectOption('enrich')
  await prompt().fill(framesPrompt)
  await button('优化后生成视频').click()
  await page.getByText(/首帧与尾帧需要 2/).waitFor()
  assert.equal(await dialog().count(), 0)
  assert.equal(fixture.writers.length, 2)
  await pick('尾帧选择本地文件', lastFrame)
  await pick('首帧选择本地文件', firstFrame)
  await page.locator('.file-row').nth(1).waitFor()
  await prompt().press('Control+Enter')
  await seeProposal(framesProposal)
  const editedVideo = framesProposal + ' 结尾停留一秒。'
  await proposal().fill(editedVideo)
  assert.equal(fixture.videos.length, 0)
  assert.equal(await prompt().inputValue(), framesPrompt)
  assert.match(fixture.writers.at(-1).system, /丰富细节/)
  assert.match(fixture.writers.at(-1).system, /已指定首尾帧/)
  await shot('视频生成前优化')
  await button('采用并生成视频').click()
  const videoJob = await checkJob(editedVideo, 1)
  const { model, input, parameters } = fixture.videos[0]
  assert.equal(model, '两帧视频')
  assert.equal(input.prompt, editedVideo)
  assert.deepEqual(parameters, { resolution: '720P', duration: 5 })
  for (const [url, file] of [[input.first_frame_url, firstFrame], [input.last_frame_url, lastFrame]]) {
    assert.ok(url.startsWith('data:image/png;base64,'))
    assert.ok(Buffer.from(url.split(',')[1], 'base64').equals(await readFile(file)), 'Wrong frame bytes or order')
  }
  assert.ok((await readFile(videoJob.mediaPath)).equals(video))
  assert.equal(await prompt().inputValue(), editedVideo)

  await openScene(0, 'video')
  assert.equal(await mode().inputValue(), '')
  await service().selectOption(textId)
  await mode().selectOption('enrich')
  await prompt().fill(fallbackPrompt)
  await button('优化后生成视频').click()
  await dialog().getByRole('alert').waitFor()
  await button('用原文生成').click()
  await checkJob(fallbackPrompt, 0)
  assert.deepEqual(fixture.videos[1].input, { prompt: fallbackPrompt })
  await prompt().fill(textVideoPrompt)
  await button('优化后生成视频').click()
  await seeProposal(textVideoProposal)
  await button('采用并生成视频').click()
  await checkJob(textVideoProposal, 0)
  assert.deepEqual(fixture.videos[2].input, { prompt: textVideoProposal })
  assert.match(fixture.writers.at(-1).system, /目标是视频/)
  await service().selectOption('@site')
  await page.getByLabel('官网模板').selectOption(processingTemplate)
  assert.equal(await mode().count(), 0)

  page = await restart()
  await openScene(0, 'image')
  assert.equal(await mode().inputValue(), 'polish')
  assert.equal(await prompt().inputValue(), editedImage)
  await button('还原原文').click()
  assert.equal(await prompt().inputValue(), imagePrompt)
  await openScene(1, 'video')
  assert.equal(await mode().inputValue(), 'enrich')
  assert.equal(await prompt().inputValue(), editedVideo)
  assert.equal(await page.locator('.file-row').count(), 2)
  await button('优化后生成视频').click()
  await seeProposal(editedVideo)
  await button('关闭对照').click()
  assert.deepEqual(fixture.writers.map(w => w.original), [slowPrompt, imagePrompt, framesPrompt, fallbackPrompt, textVideoPrompt])
  assert.equal(fixture.images.length, 4)
  assert.equal(fixture.videos.length, 3)
  console.log('Generation prompt review passed: direct, edited single/dual images, text video, frame-accurate video, rejection fallback, stale reply isolation and normal restart.')
}
