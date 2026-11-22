import assert from 'node:assert/strict'
import { waitForValue } from './wait-for-value.mjs'

export function writerRelayFixture() {
  const requests = []
  return {
    requests,
    handle(req, res, bytes) {
      const account = req.headers.authorization?.replace('Bearer fixture-', '')
      res.setHeader('Content-Type', 'application/json')
      if (req.url.endsWith('/models')) {
        requests.push({ route: 'models', account })
        res.end(JSON.stringify({ data: account ? [{ id: 'shared-chat' }, { id: 'writer-' + account }] : [] }))
        return
      }
      assert.equal(req.url, '/v1/chat/completions')
      assert.ok(['a', 'b'].includes(account))
      const body = JSON.parse(bytes)
      requests.push({ route: 'chat', account, model: body.model })
      const content = body.messages[0].content.includes('影视编剧') ? JSON.stringify({
        title: '分镜来自 ' + account, scenes: [{ heading: '渡口', action: '船靠岸', dialogue: '到了', imagePrompt: '岸边的船', videoPrompt: '镜头推近' }],
      }) : '来自 ' + account
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }))
    },
  }
}

export async function exerciseWriterConnections({ page, base, restart, shot, fixture }) {
  const button = name => page.getByRole('button', { name, exact: true })
  const dialog = () => page.getByRole('dialog')
  const card = name => page.getByRole('article', { name, exact: true })
  const region = () => page.getByRole('region', { name: '中转站与自定义接口', exact: true })
  const settings = () => page.evaluate(() => window.studio.settings())
  await button('设置').click()
  await button('剧本模型').click()
  await card('DeepSeek').waitFor()
  for (const [account, name] of [['a', '星桥中转站'], ['b', '云帆中转站']]) {
    await button('添加剧本服务').click()
    await dialog().getByLabel('服务名称').fill(name)
    await dialog().getByLabel('服务分组').selectOption('relay')
    await dialog().getByLabel('剧本服务地址').fill(base)
    if (account === 'b') {
      await button('获取模型列表').click()
      await dialog().getByText(/服务返回了空列表/).waitFor()
      assert.equal(fixture.requests.at(-1).account, undefined)
    }
    await dialog().getByLabel('剧本 API Key').fill('fixture-' + account)
    await button('获取模型列表').click()
    await dialog().getByLabel('从服务商选择模型').selectOption('shared-chat')
    await dialog().getByText('同一连接的其他模型', { exact: true }).click()
    await dialog().getByLabel('从列表加入备选模型').selectOption('writer-' + account)
    assert.equal(await dialog().getByLabel('保存后使用这个服务和模型').isChecked(), account === 'a')
    await button('保存剧本模型').click()
    await region().getByRole('article', { name }).waitFor()
    assert.equal((await settings()).writer.name, '星桥中转站')
  }
  const a = (await settings()).writer
  const b = (await settings()).writers.find(w => w.name === '云帆中转站')
  assert.deepEqual(await card(b.name).getByRole('list').locator('code').allTextContents(), ['shared-chat', 'writer-b'])

  await button('编辑 云帆中转站').click()
  assert.equal(await dialog().getByLabel('剧本 API Key').inputValue(), '')
  await button('获取模型列表').click()
  await dialog().getByLabel('从服务商选择模型').waitFor()
  assert.equal(fixture.requests.at(-1).account, 'b')
  await dialog().getByLabel('从服务商选择模型').selectOption('writer-b')
  await dialog().getByText('同一连接的其他模型', { exact: true }).click()
  assert.equal(await dialog().getByLabel('备选模型 ID').inputValue(), 'shared-chat')
  await button('取消').click()
  await button('使用 云帆中转站 的 shared-chat').click()
  await card(b.name).getByText('当前使用').waitFor()
  const messages = [{ role: 'system', content: '测试' }, { role: 'user', content: '改稿' }]
  const stale = await page.evaluate(async ({ a, messages }) => {
    try { await window.studio.promptAgentStep(a, messages); return '' } catch (e) { return String(e) }
  }, { a: { id: a.id, base, model: a.model }, messages })
  assert.match(stale, /已更换/)
  assert.equal(fixture.requests.filter(r => r.route === 'chat').length, 0)
  assert.equal((await page.evaluate(({ b, messages }) => window.studio.promptAgentStep(b, messages),
    { b: { id: b.id, base, model: b.model }, messages })).text, '来自 b')

  await button('剧本').click()
  await page.getByLabel('故事构想').fill('日落前的渡口')
  await page.getByLabel('分镜数量').selectOption('1')
  await page.getByLabel('剧本服务与模型').selectOption(JSON.stringify([a.id, 'writer-a']))
  await waitForValue(async () => (await settings()).writer.model === 'writer-a', 'script desk selection')
  await button('生成剧本').click()
  await page.getByRole('heading', { name: '分镜来自 a' }).waitFor()
  assert.deepEqual(fixture.requests.at(-1), { route: 'chat', account: 'a', model: 'writer-a' })

  page = await restart()
  assert.equal((await settings()).writer.id, a.id)
  assert.equal((await settings()).writer.model, 'writer-a')
  await button('设置').click()
  await button('剧本模型').click()
  await button('使用 云帆中转站 的 writer-b').click()
  await card(b.name).getByText('当前使用').waitFor()
  const result = await page.evaluate(() => window.studio.optimizePrompt({ prompt: '润色渡口场景', kind: 'image', mode: 'polish', references: 'none' }))
  assert.equal(result.text, '来自 b')
  assert.deepEqual(fixture.requests.at(-1), { route: 'chat', account: 'b', model: 'writer-b' })
  const current = page.getByRole('region', { name: '当前剧本模型' })
  await current.getByRole('heading', { name: 'writer-b', exact: true }).waitFor()
  await shot('剧本中转站', region())
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  for (const width of [760, 320]) {
    await page.setViewportSize({ width, height: 680 })
    assert.ok(await page.locator('.media-preferences').evaluate(el => el.scrollWidth <= el.clientWidth + 1))
  }
  await page.setViewportSize(viewport)
  await button('移除 云帆中转站').click()
  await button('取消').click()
  assert.equal((await settings()).writer.id, b.id)
  await button('移除 云帆中转站').click()
  await dialog().getByText(/移除后将使用「星桥中转站 · writer-a」/).waitFor()
  await button('移除服务').click()
  await card(b.name).waitFor({ state: 'detached' })
  const fallback = (await settings()).writer
  assert.equal(fallback.id, a.id)
  assert.ok(fallback.hasKey)
  console.log('Writer services passed: separate catalogs and keys on the same URL, per-model selection, script, optimization and chat routing, restart and removal.')
}
