import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

const askNative = '使用银盐模板，并找回第一轮的道具编号。'
const askCompat = '兼容模式查找银盐模板。'
const askQuota = '检查额度错误。'
const restored = '银盐效果 PRESET-73，保留第一稿的道具编号 VAULT-27。'

export function templateFixture() {
  const counts = new Map()
  return {
    counts,
    handle(req, res, bytes) {
      if (req.url !== '/template-writer/v1/chat/completions') return false
      assert.equal(req.headers.authorization, 'Bearer template-test-only')
      const body = JSON.parse(bytes)
      const request = body.messages
        .filter((m) => m.role === 'user')
        .map((m) => {
          try {
            return JSON.parse(m.content)?.request
          } catch {
            return undefined
          }
        })
        .filter(Boolean)
        .at(-1)
      counts.set(request, (counts.get(request) ?? 0) + 1)
      const answer = (text) => ({
        role: 'assistant',
        content: JSON.stringify({ action: 'draft', reply: '已按资料修订。', prompt: text }),
      })
      const calls = (id, name, query) => ({
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify({ query }) },
      })
      let message,
        finish_reason = 'stop'
      if (request === askNative) {
        assert.deepEqual(body.response_format, { type: 'json_object' })
        if (body.messages.at(-1).role !== 'tool') {
          assert.ok(
            body.tools.some(
              (t) =>
                t.function.name === 'find_templates' && t.function.parameters.required.includes('query')
            )
          )
          assert.ok(body.tools.some((t) => t.function.name === 'recall_drafts'))
          assert.doesNotMatch(JSON.stringify(body.messages), /PRESET-73|VAULT-27/)
          message = {
            role: 'assistant',
            content: null,
            reasoning_content: 'native-private-marker',
            tool_calls: [
              calls('call-template', 'find_templates', '银盐'),
              calls('call-history', 'recall_drafts', '第1轮'),
            ],
          }
          finish_reason = 'tool_calls'
        } else {
          const assistant = body.messages.at(-3)
          assert.equal(assistant.reasoning_content, 'native-private-marker')
          assert.deepEqual(
            assistant.tool_calls.map((x) => x.id),
            ['call-template', 'call-history']
          )
          const results = body.messages.slice(-2)
          assert.deepEqual(
            results.map((x) => x.tool_call_id),
            ['call-template', 'call-history']
          )
          assert.match(results[0].content, /PRESET-73/)
          assert.match(results[1].content, /VAULT-27/)
          message = answer(restored)
        }
      } else if (request === '修正交稿格式') {
        if (body.tools?.length) message = { role: 'assistant', content: '一段未按约定包装的草稿。' }
        else {
          assert.ok(JSON.parse(body.messages.at(-1).content).formatCorrection)
          assert.deepEqual(body.response_format, { type: 'json_object' })
          message = answer('恢复后的结构化稿。')
        }
      } else if (request === askCompat) {
        if (body.tools?.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'This endpoint does not support tools' } }))
          return true
        }
        assert.deepEqual(body.response_format, { type: 'json_object' })
        const input = JSON.parse(body.messages.at(-1).content)
        if (!input.toolResult)
          message = {
            role: 'assistant',
            content: JSON.stringify({ action: 'find_templates', query: '银盐' }),
          }
        else {
          assert.equal(input.toolResult, 'find_templates')
          assert.match(JSON.stringify(input.data), /PRESET-73/)
          message = answer('兼容稿 PRESET-73。')
        }
      } else if (request === askQuota) {
        res.writeHead(429, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'credits exhausted' } }))
        return true
      } else assert.fail('unexpected template fixture request')
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ choices: [{ finish_reason, message }] }))
      return true
    },
  }
}

export async function exerciseTemplates({ page, base, fixture, data, restart }) {
  const button = (name) => page.getByRole('button', { name, exact: true })
  const picker = () => page.getByRole('dialog', { name: '提示词模板', exact: true })
  const optimizer = () => page.getByRole('dialog', { name: '优化提示词', exact: true })
  const chat = () => page.getByRole('dialog', { name: '对话改稿', exact: true })
  const openEditor = () => page.getByRole('button', { name: /^(优化提示词|查看优化稿)$/ }).click()
  async function templates() {
    await optimizer().getByRole('button', { name: '提示词模板' }).click()
    await picker().getByLabel('选择模板').waitFor()
  }
  async function openManage() {
    await picker().getByText('管理与分享', { exact: true }).click()
  }
  async function selectTemplate(text) {
    const options = picker().getByLabel('选择模板')
    const value = await options.locator('option').filter({ hasText: text }).first().getAttribute('value')
    assert.ok(value)
    await options.selectOption(value)
  }
  async function send(request) {
    await chat().getByLabel('改稿要求').fill(request)
    await chat().getByRole('button', { name: '发送改稿要求' }).click()
  }
  const jobsBefore = await page.evaluate(async () => (await window.studio.state()).jobs.length)
  const project = await page.evaluate(async (endpoint) => {
    await window.studio.saveWriter({
      base: endpoint + '/template-writer/v1',
      model: 'template-agent',
      key: 'template-test-only',
    })
    return window.studio.createScript({
      title: '模板分享验收',
      scenes: [
        {
          id: '',
          heading: '银盐码头',
          action: '两只木箱',
          dialogue: '',
          imagePrompt: '雾中的木箱',
          videoPrompt: '缓慢横移',
        },
      ],
    })
  }, new URL(base).origin)
  const scope = {
    kind: 'image',
    shot: { scriptId: project.id, sceneId: project.scenes[0].id, label: '银盐码头' },
  }
  async function openShot() {
    await button('剧本').click()
    await page.locator('.script-history').getByText('模板分享验收', { exact: true }).click()
    await page
      .locator('.shot-list > li')
      .filter({ has: page.getByRole('heading', { name: '银盐码头', exact: true }) })
      .getByRole('button', { name: '用于生图' })
      .click()
  }
  await page.reload()
  await openShot()
  await openEditor()
  await templates()
  const previousSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  await page.setViewportSize({ width: 800, height: 650 })
  assert.equal(await picker().getByRole('button', { name: '导入文件', exact: true }).isVisible(), false)
  assert.ok(await picker().evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
  if (process.env.MOBIUS_TEMPLATE_SCREENSHOT)
    await page.screenshot({ path: process.env.MOBIUS_TEMPLATE_SCREENSHOT })
  await page.setViewportSize(previousSize)
  await selectTemplate('产品布光')
  const use = () => picker().getByRole('button', { name: '放入优化稿' })
  assert.equal(await use().isEnabled(), false)
  await picker().getByLabel('主体', { exact: true }).fill('木箱')
  await picker().getByLabel('背景', { exact: true }).fill('码头')
  await picker().getByLabel('光线', { exact: true }).fill('晨光')
  await use().click()
  assert.match(await optimizer().getByLabel('优化稿', { exact: true }).inputValue(), /木箱.*码头.*晨光/)
  assert.equal(await page.locator('#prompt').inputValue(), '雾中的木箱')
  await templates()
  await openManage()
  const csv =
    '\uFEFFact,prompt,for_devs\r\n银盐测试,"底片 PRESET-73，主体 {{主体}}，色调, 冷。\n第二行",false\r\n银盐测试,另一版,false\r\n空白,,false'
  await picker()
    .getByLabel('模板文件')
    .setInputFiles({ name: 'prompts.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await picker().getByText('导入预览 · 2 个模板', { exact: true }).waitFor()
  assert.equal(
    (await page.evaluate(() => window.studio.promptTemplates())).entries.some(
      (e) => e.name === '银盐测试'
    ),
    false
  )
  await picker().getByRole('button', { name: '导入全部 2 项', exact: true }).click()
  await picker().getByRole('status').filter({ hasText: '1 个同名模板已另存' }).waitFor()
  const archiveText = '全文保留。'.repeat(3000)
  await picker()
    .getByLabel('模板文件')
    .setInputFiles({ name: '长模板.txt', mimeType: 'text/plain', buffer: Buffer.from(archiveText) })
  await picker().getByRole('button', { name: '导入此模板', exact: true }).click()
  await picker().getByLabel('本次使用的节选').waitFor()
  assert.equal(await use().isEnabled(), false)
  assert.equal(await picker().getByLabel('模板使用预览').innerText(), archiveText)
  await picker().getByLabel('本次使用的节选').fill('本次只用一段。')
  await use().click()
  assert.equal(await optimizer().getByLabel('优化稿', { exact: true }).inputValue(), '本次只用一段。')
  await templates()
  await openManage()
  await selectTemplate('银盐测试 ·')
  await picker().getByRole('button', { name: '导出当前模板', exact: true }).click()
  const exported = picker().getByRole('status').filter({ hasText: '已导出到 ' })
  await exported.waitFor()
  const file = (await exported.innerText()).replace('已导出到 ', '')
  assert.equal(await realpath(path.dirname(file)), await realpath(path.join(data, '作品', '导出')))
  const pack = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(pack.format, 'mobius-prompt-templates')
  assert.equal(pack.version, 1)
  assert.equal(pack.templates.length, 1)
  assert.deepEqual(Object.keys(pack.templates[0]).sort(), ['body', 'description', 'medium', 'name'])
  assert.match(pack.templates[0].body, /PRESET-73/)
  await picker().getByLabel('模板文件').setInputFiles(file)
  await picker().getByRole('button', { name: '导入此模板', exact: true }).click()
  await picker().getByRole('status').filter({ hasText: '跳过 1 个重复项' }).waitFor()
  await picker()
    .getByLabel('模板文件')
    .setInputFiles({
      name: '共享构图.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('场景：' + String.fromCharCode(36) + '{地点:码头}，主体 {{人物}}'),
    })
  await picker().getByRole('button', { name: '导入此模板', exact: true }).click()
  await picker().getByLabel('地点', { exact: true }).waitFor()
  assert.equal(await picker().getByLabel('地点', { exact: true }).inputValue(), '码头')
  await picker().getByLabel('人物', { exact: true }).fill('摄影师')
  await use().click()
  assert.equal(
    await optimizer().getByLabel('优化稿', { exact: true }).inputValue(),
    '场景：码头，主体 摄影师'
  )
  await optimizer().getByRole('button', { name: '采用优化稿', exact: true }).click()
  page = await restart()
  await openShot()
  assert.equal(await page.locator('#prompt').inputValue(), '场景：码头，主体 摄影师')
  await page.evaluate(async (scope) => {
    let session = await window.studio.promptSession(scope)
    for (let i = 0; i < 8; i++)
      session = await window.studio.updatePromptSession(scope, session.revision, {
        user: '旧要求 ' + i,
        original: '',
        reply: '已写',
        prompt: i === 0 ? '道具编号 VAULT-27' : '历史版本 ' + i,
        model: 'fixture',
        sources: [],
      })
  }, scope)
  await openEditor()
  await optimizer().getByRole('button', { name: '对话改稿' }).click()
  await chat().getByRole('button', { name: '提示词模板' }).click()
  await selectTemplate('共享构图')
  await picker().getByLabel('人物', { exact: true }).fill('小林')
  await picker().getByRole('button', { name: '填入改稿要求' }).click()
  assert.equal(await chat().getByLabel('改稿要求').inputValue(), '场景：码头，主体 小林')
  await send(askNative)
  await chat().getByText(restored, { exact: true }).waitFor()
  assert.equal(fixture.counts.get(askNative), 2)
  assert.match(await chat().locator('article').last().innerText(), /提示词模板、历史改稿/)
  await send('修正交稿格式')
  await chat().getByText('恢复后的结构化稿。', { exact: true }).waitFor()
  assert.equal(fixture.counts.get('修正交稿格式'), 2)
  await send(askCompat)
  await chat().getByText('兼容稿 PRESET-73。', { exact: true }).waitFor()
  assert.equal(fixture.counts.get(askCompat), 3)
  await send(askQuota)
  await chat().getByRole('alert').waitFor()
  assert.equal(fixture.counts.get(askQuota), 1)
  const saved = await page.evaluate((s) => window.studio.promptSession(s), scope)
  assert.equal(saved.turns.length, 11)
  assert.ok(!JSON.stringify(saved).includes('native-private-marker'))
  assert.equal(await page.evaluate(async () => (await window.studio.state()).jobs.length), jobsBefore)
  await chat().getByRole('button', { name: '返回对照' }).click()
  await optimizer().getByRole('button', { name: '关闭对照' }).click()
  console.log(
    'Template sharing passed: offline variables, CSV and Markdown preview, duplicate/conflict handling, exported JSON, process restart, parallel native tools, scoped history, JSON fallback and no media submissions.'
  )
}

export async function exerciseCommunityFile(page, file) {
  const button = (name) => page.getByRole('button', { name, exact: true })
  await button('优化提示词').click()
  await button('提示词模板').click()
  const dialog = page.getByRole('dialog', { name: '提示词模板', exact: true })
  await dialog.getByText('管理与分享', { exact: true }).click()
  await dialog.getByLabel('模板文件').setInputFiles(file)
  await dialog.getByText(/导入预览 · /).waitFor({ timeout: 60000 })
  const count = await dialog.getByLabel('预览待导入模板').locator('option').count()
  assert.ok(count > 1)
  await dialog.getByRole('button', { name: '导入全部 ' + count + ' 项', exact: true }).click()
  await dialog.getByRole('status').filter({ hasText: '已添加' }).waitFor({ timeout: 60000 })
  const summary = await page.evaluate(async () => {
    const lib = await window.studio.promptTemplates()
    return {
      count: lib.entries.length,
      exported: await window.studio.exportPromptTemplates(
        lib.entries.map((e) => e.id),
        false
      ),
    }
  })
  const text = await readFile(summary.exported, 'utf8')
  const again = await page.evaluate(async (raw) => {
    const preview = await window.studio.parsePromptTemplates('roundtrip.json', raw)
    const lib = await window.studio.promptTemplates()
    const repeat = await window.studio.changePromptTemplates(lib.revision, {
      action: 'import',
      templates: preview.templates,
    })
    return { count: preview.templates.length, added: repeat.added, skipped: repeat.skipped }
  }, text)
  assert.deepEqual(again, { count: summary.count, added: 0, skipped: summary.count })
  console.log(
    'Community CSV: ' +
      count +
      ' valid inputs, ' +
      summary.count +
      ' library entries including built-ins, exported JSON imported again without duplicates.'
  )
}
