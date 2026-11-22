import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { waitForValue } from './wait-for-value.mjs'

const imageA = 'Three red umbrellas at the west entrance. Keep the sign “OPEN”.'
const imageB = '清晨的蓝桥，桥面上只有一辆自行车。'
const videoB = '从静止的河岸缓缓推近到桥面。'
const polished = 'At the west entrance stand three red umbrellas. The sign reads “OPEN”.'
const enriched = '清晨薄雾中的蓝桥，湿润的桥面反射天光，画面中仅有一辆自行车。'
const motion = '镜头从既定首帧平稳前推，沿河岸靠近桥面，在尾帧的构图上停稳。'

export function optimizerFixture(png) {
  const gate = Promise.withResolvers(), started = Promise.withResolvers()
  const textCalls = [], imageCalls = []
  return { textCalls, imageCalls, started: started.promise, release: gate.resolve, async handle(req, res, bytes) {
    if (req.url === '/opt-images/v1/images/generations') {
      assert.equal(req.headers.authorization, 'Bearer media-only')
      imageCalls.push(JSON.parse(bytes.toString()))
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
      return true
    }
    if (req.url !== '/opt-writer/v1/chat/completions') return false
    assert.equal(req.method, 'POST')
    assert.equal(req.headers.authorization, 'Bearer writer-only')
    const body = JSON.parse(bytes.toString())
    assert.equal(body.model, 'text-editor-test')
    assert.equal(body.response_format, undefined)
    assert.deepEqual(body.messages.map(m => m.role), ['system', 'user'])
    const [system, original] = body.messages.map(m => m.content)
    assert.match(system, /保留原文语言、人物、数量/)
    assert.match(system, /纯文本提示词/)
    assert.ok([imageA, imageB, videoB].includes(original))
    textCalls.push(original)
    if (original === imageA) {
      assert.match(system, /润色原意/); assert.match(system, /单张图片/)
      started.resolve(); await gate.promise
    } else if (original === imageB) {
      assert.match(system, /丰富细节/); assert.match(system, /单张图片/)
    } else {
      assert.match(system, /丰富细节/); assert.match(system, /目标是视频/); assert.match(system, /已指定首尾帧/)
      if (textCalls.filter(p => p === videoB).length === 1) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'fixture unavailable writer-only' } }))
        return true
      }
    }
    const text = original === imageA ? polished : original === imageB ? enriched : motion
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] }))
    return true
  } }
}

export async function exerciseOptimizer({ page, base, fixture, record, shot, restart, referenceFile }) {
  const root = new URL(base).origin
  const button = name => page.getByRole('button', { name, exact: true })
  const tool = () => page.getByRole('dialog', { name: '优化提示词' })
  const original = () => tool().getByLabel('优化原文')
  const suggestion = () => tool().getByLabel('优化稿', { exact: true })
  const prompt = () => page.locator('#prompt')
  const review = async text => {
    await page.waitForFunction(expected => document.querySelector('textarea[aria-label="优化稿"]')?.value === expected, text)
  }
  async function openScene(heading, kind = '图片') {
    await button('剧本').click()
    await page.locator('.shot-list > li').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
      .getByRole('button', { name: kind === '图片' ? '用于生图' : '用于视频', exact: true }).click()
  }
  // Every IPC, media request and settings change below uses the test instance's disposable MOBIUS_HOME.
  await page.evaluate(async target => {
    const { storage } = await window.studio.settings()
    if (storage.automatic) await window.studio.saveStorage({ ...storage, automatic: false }, '')
    await window.studio.saveWriter({ base: target + '/opt-empty/v1', model: 'unconfigured', key: '' })
    await window.studio.createScript({ title: '提示词工具双镜验收', scenes: [
      { id: '', heading: '西门红伞', action: '红伞', dialogue: '', imagePrompt: '红伞', videoPrompt: '镜头推近' },
      { id: '', heading: '清晨蓝桥', action: '蓝桥', dialogue: '', imagePrompt: '蓝桥', videoPrompt: '桥面推近' },
    ] })
  }, root)
  await page.reload()
  await button('优化提示词').click()
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '优化原文', undefined, { timeout: 3000 })
  await button('丰富细节').click()
  assert.equal(await button('丰富细节').getAttribute('aria-pressed'), 'true')
  await original().click()
  await page.keyboard.type('Frame A')
  await original().press('Enter')
  const ime = await page.context().newCDPSession(page)
  await ime.send('Input.imeSetComposition', { text: 'yu', selectionStart: 2, selectionEnd: 2 })
  await ime.send('Input.insertText', { text: '雨后码头' })
  await ime.detach()
  await suggestion().click()
  await page.keyboard.insertText('手写优化稿，保留远处的灯塔。')
  assert.deepEqual([await original().inputValue(), await suggestion().inputValue()],
    ['Frame A\n雨后码头', '手写优化稿，保留远处的灯塔。'], 'Both empty optimizer fields must accept keyboard input')
  assert.equal(await prompt().inputValue(), 'Frame A\n雨后码头')
  await button('采用优化稿').click()
  assert.equal(await prompt().inputValue(), '手写优化稿，保留远处的灯塔。')
  await button('还原原文').click()
  assert.equal(await prompt().inputValue(), 'Frame A\n雨后码头')
  assert.deepEqual(fixture.textCalls, [])
  assert.equal(fixture.imageCalls.length, 0)
  await openScene('西门红伞')
  await prompt().fill(imageA)
  await button('优化提示词').click()
  await tool().getByRole('button', { name: '配置剧本模型' }).click()
  await page.getByLabel('剧本服务地址').fill(root + '/opt-writer/v1')
  await page.getByLabel('剧本 API Key').fill('writer-only')
  await page.getByLabel('剧本模型 ID', { exact: true }).fill('text-editor-test')
  await button('保存剧本模型').click()
  await page.getByText('设置已保存。', { exact: true }).waitFor()
  await button('创作台').click()
  assert.equal(await prompt().inputValue(), imageA)
  await button('优化提示词').click()
  assert.equal(await original().inputValue(), imageA)
  assert.equal(await tool().getByRole('button', { name: '润色原意' }).getAttribute('aria-pressed'), 'true')
  await page.evaluate(() => {
    const optimize = window.studio.optimizePrompt
    window.studio.optimizePrompt = () => {
      window.studio.optimizePrompt = optimize
      return new Promise(resolve => { window.finishDelayedEdit = () => resolve({ text: '较早请求的回复', model: 'test' }) })
    }
  })
  await button('开始优化').click()
  await page.waitForFunction(() => typeof window.finishDelayedEdit === 'function')
  const manual = '正在等待时手写的版本。'
  const revised = '在弹窗内修改后的原文。'
  await suggestion().click()
  await page.keyboard.insertText(manual)
  await original().fill(revised)
  await page.evaluate(async () => {
    window.finishDelayedEdit()
    delete window.finishDelayedEdit
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
  assert.equal(await suggestion().inputValue(), manual)
  await button('关闭对照').click()
  assert.equal(await prompt().inputValue(), revised)
  await button('查看优化稿').click()
  assert.equal(await original().inputValue(), revised)
  assert.equal(await suggestion().inputValue(), manual)
  await button('采用优化稿').click()
  await button('还原原文').click()
  assert.equal(await prompt().inputValue(), revised)
  await button('优化提示词').click()
  await original().fill(imageA)
  await button('开始优化').click()
  await button('收起').click()
  const newerDraft = imageA + ' Keep the lettering level.'
  await prompt().fill(newerDraft)
  await openScene('清晨蓝桥')
  await prompt().fill(imageB)
  await button('优化提示词').click()
  await button('丰富细节').click()
  await button('开始优化').click()
  await review(enriched)
  const editedB = enriched + ' 保留右侧留白。'
  await suggestion().fill(editedB)
  await shot('丰富细节对照')
  await Promise.race([fixture.started, delay(10000, null, { ref: false }).then(() => { throw Error('First writer request did not arrive') })])
  fixture.release()
  await waitForValue(() => page.evaluate(async text => (await window.studio.shotDrafts()).some(d => d.editor.suggestion?.text === text), polished),
    'the background suggestion to be saved to its shot')
  const latestPrompt = await page.evaluate(async () => (await window.studio.shotDrafts())[0].editor.prompt)
  assert.equal(latestPrompt, imageB, 'A background reply changed which draft is resumed on startup')
  assert.equal(await original().inputValue(), imageB)
  assert.equal(await suggestion().inputValue(), editedB)
  await button('关闭对照').click()
  assert.equal(await prompt().inputValue(), imageB)
  assert.equal(fixture.imageCalls.length, 0)
  await openScene('西门红伞')
  assert.equal(await prompt().inputValue(), newerDraft)
  await button('查看优化稿').click()
  assert.equal(await original().inputValue(), newerDraft)
  await tool().getByText('当前草稿已修改，查看优化时的原文').click()
  assert.equal(await tool().locator('.optimizer-history p').innerText(), imageA)
  await review(polished)
  const adopted = polished + ' Keep the composition level.'
  await suggestion().fill(adopted)
  await shot('提示词优化对照')
  await button('替换当前草稿').click()
  assert.equal(await prompt().inputValue(), adopted)
  const id = await record({ name: '对照生图服务', base: root + '/opt-images/v1', protocol: 'openai-image',
    model: 'image-left', models: ['image-right'], key: 'media-only' })
  await page.getByLabel('生成服务').selectOption(id)
  await page.getByLabel('对比模型', { exact: true }).selectOption(JSON.stringify([id, 'image-right']))
  await button('用两个模型生成').click()
  const pair = page.getByRole('dialog', { name: '双模型对比' })
  await pair.locator('img').nth(1).waitFor()
  assert.deepEqual(fixture.imageCalls.map(c => c.model).sort(), ['image-left', 'image-right'])
  assert.ok(fixture.imageCalls.every(c => c.prompt === adopted))
  await pair.getByRole('button', { name: '关闭' }).click()
  await openScene('清晨蓝桥', '视频')
  await page.getByLabel('创作方式').selectOption('first_last')
  for (const label of ['首帧选择本地文件', '尾帧选择本地文件']) {
    await page.evaluate(file => {
      const pick = window.studio.pick
      window.studio.pick = kind => { window.studio.pick = pick; return window.studio.drop(kind, [file]) }
    }, referenceFile)
    await button(label).click()
  }
  await page.locator('.file-row').nth(1).waitFor()
  await prompt().fill(videoB)
  await button('优化提示词').click()
  await button('丰富细节').click()
  await button('开始优化').click()
  const error = tool().getByRole('alert')
  await error.waitFor()
  assert.ok(!(await error.innerText()).includes('writer-only'))
  assert.equal(await original().inputValue(), videoB)
  await button('开始优化').click()
  await review(motion)
  await button('采用优化稿').click()
  assert.equal(await prompt().inputValue(), motion)
  page = await restart()
  await openScene('清晨蓝桥')
  assert.equal(await prompt().inputValue(), imageB)
  await button('查看优化稿').click()
  assert.equal(await suggestion().inputValue(), editedB)
  await button('采用优化稿').click()
  assert.equal(await prompt().inputValue(), editedB)
  await button('还原原文').click()
  assert.equal(await prompt().inputValue(), imageB)
  await openScene('清晨蓝桥', '视频')
  assert.equal(await prompt().inputValue(), motion)
  await button('还原原文').click()
  assert.equal(await prompt().inputValue(), videoB)
  await openScene('西门红伞')
  assert.equal(await prompt().inputValue(), adopted)
  await button('还原原文').click()
  assert.equal(await prompt().inputValue(), newerDraft)
  assert.deepEqual(fixture.textCalls, [imageA, imageB, videoB, videoB])
  assert.equal(fixture.imageCalls.length, 2)
  console.log('Prompt optimizer passed: shared writer, both modes, out-of-order shot replies, editable review, stale draft undo, frame-aware video retry, restart and identical accepted prompts to two image models.')
}
