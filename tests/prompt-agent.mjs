import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const note = '全片沿用靛蓝色窗框。'
const firstDraft = '靛蓝窗框内的白瓷杯，镜头从既定首帧推向杯沿。'
const nextDraft = firstDraft + ' 保持两秒静止。'
const firstRequest = '结合剧本和参考素材写第一稿。'
const followup = '沿用上一版，把结尾改成停两秒。'

export function agentFixture() {
  const calls = [], slow = Promise.withResolvers(), arrived = Promise.withResolvers()
  return { calls, slow, arrived, async handle(req, res, bytes) {
    if (req.url !== '/agent-writer/v1/chat/completions') return false
    assert.equal(req.headers.authorization, 'Bearer local-agent-writer')
    const { messages, response_format, model, tools } = JSON.parse(bytes)
    assert.equal(model, 'agent-fixture')
    if (tools?.length) assert.ok(tools.every(t => t.type === 'function'))
    else assert.deepEqual(response_format, { type: 'json_object' })
    assert.match(messages[0].content, /availableTools/)
    const context = messages.filter(m => m.role === 'user').map(m => {
      try { return JSON.parse(m.content) } catch { return null }
    }).findLast(item => item?.request)
    const last = JSON.parse(messages.at(-1).content)
    calls.push({ request: context.request, tool: last.toolResult })
    let action
    if (context.request === firstRequest) {
      assert.equal(context.medium, 'video')
      assert.equal(context.memory, note)
      if (!last.toolResult) {
        assert.deepEqual(context.availableTools, ['read_shot', 'read_references', 'find_templates'])
        action = { action: 'read_shot' }
      } else if (last.toolResult === 'read_shot') {
        assert.equal(last.data.heading, '窗边的搪瓷杯')
        assert.match(last.data.action, /放下/)
        assert.equal(last.data.nextHeading, '窗外的树影')
        action = { action: 'read_references' }
      } else {
        assert.deepEqual(last.data, { arrangement: 'first_frame', counts: { image: 1 } })
        action = { action: 'draft', reply: '沿用窗框颜色并从首帧推进。', prompt: firstDraft }
      }
    } else if (context.request === followup) {
      assert.ok(messages.some(m => m.role === 'assistant' && m.content.includes(firstDraft)))
      assert.ok(messages.some(m => m.role === 'user' && m.content.includes(firstRequest)))
      assert.equal(context.memory, note)
      action = { action: 'draft', reply: '在结尾增加停留。', prompt: nextDraft }
    } else if (context.request === '先确认光线') {
      action = { action: 'reply', reply: '想要晨光还是黄昏？' }
    } else if (context.request === '重复资料') {
      action = { action: 'read_shot' }
    } else if (context.request === '无效输出') {
      action = { action: 'run_shell' }
    } else if (context.request === '取消测试') {
      arrived.resolve()
      await slow.promise
      action = { action: 'read_shot' }
    } else assert.fail('Unexpected prompt agent turn')
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
      reasoning_content: 'private-test-marker', content: JSON.stringify(action),
    } }] }))
    return true
  } }
}

export async function exerciseAgent({ page, base, fixture, referenceFile, restart }) {
  const id = await page.evaluate(async origin => {
    await window.studio.saveWriter({ base: origin + '/agent-writer/v1', model: 'agent-fixture', key: 'local-agent-writer' })
    const project = await window.studio.createScript({ title: '窗影改稿对话', scenes: [
      { id: '', heading: '窗边的搪瓷杯', action: '桌上放下一只杯子', dialogue: '', imagePrompt: '窗台与杯子', videoPrompt: '从窗边推近' },
      { id: '', heading: '窗外的树影', action: '树枝轻晃', dialogue: '', imagePrompt: '枝条', videoPrompt: '树影晃动' },
    ] })
    return { scriptId: project.id, sceneId: project.scenes[0].id }
  }, new URL(base).origin)
  const before = await page.evaluate(async () => (await window.studio.state()).jobs.length)
  const button = name => page.getByRole('button', { name, exact: true })
  const chat = () => page.getByRole('dialog', { name: '对话改稿', exact: true })
  const latest = () => chat().locator('article').last()
  const scope = { kind: 'video', shot: id }
  async function openShot(title, kind = '视频') {
    await button('剧本').click()
    await page.locator('.shot-list > li').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
      .getByRole('button', { name: kind === '视频' ? '用于视频' : '用于生图' }).click()
  }
  async function openChat() {
    await page.getByRole('button', { name: /^(优化提示词|查看优化稿)$/ }).click()
    await button('对话改稿').click()
  }
  async function send(request) {
    await chat().getByLabel('改稿要求').fill(request)
    await button('发送改稿要求').click()
  }
  await page.reload()
  await openShot('窗边的搪瓷杯')
  await page.getByLabel('生成服务').selectOption('@site')
  await page.getByLabel('创作方式').selectOption('first_frame')
  await page.evaluate(file => {
    const pick = window.studio.pick
    window.studio.pick = kind => { window.studio.pick = pick; return window.studio.drop(kind, [file]) }
  }, referenceFile)
  await page.locator('[data-slot="image"]').getByRole('button', { name: /选择本地文件$/ }).first().click()
  await page.locator('.file-row').first().waitFor()
  await openChat()
  await chat().locator('summary').click()
  await chat().getByLabel('长期创作要求').fill(note)
  await button('保存记忆').click()
  await chat().getByText('本剧本的创作记忆 · 已保存', { exact: true }).waitFor()
  await send(firstRequest)
  await latest().getByText(firstDraft, { exact: true }).waitFor()
  assert.match(await latest().innerText(), /已查阅 分镜资料、参考素材信息/)
  assert.equal(fixture.calls.length, 3)
  await button('放入优化稿').click()
  assert.equal(await page.getByLabel('优化稿', { exact: true }).inputValue(), firstDraft)
  assert.equal(await page.locator('#prompt').inputValue(), '从窗边推近')
  await button('采用优化稿').click()
  assert.equal(await page.locator('#prompt').inputValue(), firstDraft)
  page = await restart()
  await openShot('窗边的搪瓷杯')
  await openChat()
  await latest().getByText(firstDraft, { exact: true }).waitFor()
  await send(followup)
  await latest().getByText(nextDraft, { exact: true }).waitFor()
  assert.equal(fixture.calls.length, 4)
  await send('先确认光线')
  await latest().getByText('想要晨光还是黄昏？').waitFor()
  assert.equal(await latest().getByRole('button', { name: '放入优化稿' }).count(), 0)
  await send('无效输出')
  await chat().getByRole('alert').filter({ hasText: '格式无效' }).waitFor()
  await send('重复资料')
  await chat().getByRole('alert').filter({ hasText: '已读' }).waitFor()
  await send('取消测试')
  await fixture.arrived.promise
  await button('停止并返回').click()
  fixture.slow.resolve()
  await button('关闭对照').click()
  await openShot('窗外的树影', '图片')
  await openChat()
  await chat().getByText('本剧本的创作记忆 · 已保存', { exact: true }).waitFor()
  assert.equal(await chat().locator('article').count(), 0)
  const saved = await page.evaluate(scope => window.studio.promptSession(scope), scope)
  assert.equal(saved.turns.length, 3)
  assert.ok(!JSON.stringify(saved).includes('private-test-marker'))
  assert.equal(fixture.calls.filter(c => c.request === '取消测试').length, 1)
  assert.equal(await page.evaluate(async () => (await window.studio.state()).jobs.length), before)
  await button('返回对照').click()
  await button('关闭对照').click()
  console.log('Prompt agent: two tools, scoped memory, follow-up after process restart, clarification, explicit adoption, invalid replies, cancellation and zero media submissions passed.')
}

// Opt-in Windows verification uses only the selected writer's already-encrypted key in disposable test data.
export async function prepareLiveWriter(data, settingsFile) {
  const { writer } = JSON.parse((await readFile(settingsFile, 'utf8')).replace(/^\uFEFF/, ''))
  assert.equal(new URL(writer.BaseUrl).protocol, 'https:')
  const encrypted = writer.Keys[writer.BaseUrl]
  assert.ok(typeof encrypted === 'string' && encrypted.length > 0, 'No saved Windows credential for this writer endpoint')
  await writeFile(path.join(data, 'settings.json'), JSON.stringify({ writer: {
    Id: writer.Id, BaseUrl: writer.BaseUrl, Model: writer.Model, Keys: { [writer.BaseUrl]: encrypted },
  } }))
}

export async function exerciseLiveAgent(page, restart) {
  const button = name => page.getByRole('button', { name, exact: true })
  const open = async () => { await button('优化提示词').click(); await button('对话改稿').click() }
  const chat = () => page.getByRole('dialog', { name: '对话改稿', exact: true })
  let modelRequests = 0
  const nativeReads = []
  async function observe() {
    await page.exposeFunction('countWriterStep', tools => { modelRequests++; nativeReads.push(...tools) })
    await page.evaluate(() => {
      const step = window.studio.promptAgentStep
      window.studio.promptAgentStep = async (...args) => { const result=await step(...args); await window.countWriterStep((result.calls ?? []).map(c=>c.name)); return result }
    })
  }
  async function send(text, index) {
    await chat().getByLabel('改稿要求').fill(text)
    await button('发送改稿要求').click()
    const outcome = chat().locator('article').nth(index)
    await outcome.or(chat().getByRole('alert')).first().waitFor({ timeout: 110000 })
    const alert = chat().getByRole('alert')
    if (await alert.count()) throw Error('Live writer rejected request: ' + await alert.innerText())
    return outcome.locator('blockquote').innerText({ timeout: 5000 })
  }
  await observe()
  await open()
  const a = await send('请直接写一条中文图片提示词。桌上有一只白杯，杯上清楚地写着字母 KITE。', 0)
  assert.match(a, /KITE/)
  page = await restart()
  await observe()
  await open()
  const b = await send('继续修改上一稿：保持杯上字母原样，把背景改成深蓝色。直接交一版完整提示词。', 1)
  assert.match(b, /KITE/); assert.match(b, /蓝|靛/)
  assert.ok(modelRequests >= 2 && modelRequests <= 8)
  const beforeShot = modelRequests
  await button('返回对照').click()
  await button('关闭对照').click()
  await page.evaluate(() => window.studio.createScript({ title: '分镜资料实测', scenes: [{
    id: '', heading: '仓库', action: '纸箱正面印着唯一编号 ORB-731。', dialogue: '', imagePrompt: '一只封好的纸箱', videoPrompt: '固定镜头',
  }] }))
  await button('剧本').click()
  await page.locator('.shot-list > li').filter({ has: page.getByRole('heading', { name: '仓库', exact: true }) })
    .getByRole('button', { name: '用于生图' }).click()
  await open()
  const c = await send('请查阅当前分镜资料，从动作栏取出箱子上的唯一编号，原样写进完整的中文图片提示词。', 0)
  assert.match(c, /ORB-731/)
  assert.match(await chat().locator('article').innerText(), /已查阅 分镜资料/)
  assert.ok(modelRequests-beforeShot>=2 && modelRequests-beforeShot<=4)
  await page.evaluate(async () => {
    const lib=await window.studio.promptTemplates()
    await window.studio.changePromptTemplates(lib.revision,{action:'import',templates:[
      {name:'暗房签名',medium:'image',description:'画面必须保留的物品铭牌',body:'纸箱上的专属暗房铭牌是 TPL-418。'}]})
  })
  const beforeTemplate=modelRequests
  const templated=await send('请实际查找模板库里的“暗房签名”，把模板正文中的铭牌号原样写进完整图片提示词。',1)
  assert.match(templated,/TPL-418/)
  assert.match(await chat().locator('article').last().innerText(),/已查阅 提示词模板/)
  assert.ok(modelRequests-beforeTemplate>=2 && modelRequests-beforeTemplate<=4)
  const settings = await page.evaluate(() => window.studio.settings())
  console.log('Live writer ' + settings.writer.model + ': '+modelRequests+' model calls; KITE across restart, ORB-731 from the shot, TPL-418 from the local template. Native calls: '+nativeReads.join(', '))

}
