import assert from 'node:assert/strict'

// A connection file from before service groups were stored.
export const legacyRelay = {
  Id: '1'.repeat(32), Name: '示例中转站', ProtocolId: 'relay-image',
  BaseUrl: 'https://relay.example/v1', Model: 'gpt-image-2-azure', Models: ['image-fast'],
  Relay: { auth: 'bearer', submit: 'images/generations', body: '{}', url: 'data.0.url', sizes: ['1024x1024'] },
}

export async function exerciseConnectionGroups({ page, restart, shot }) {
  const button = name => page.getByRole('button', { name, exact: true })
  const region = name => page.getByRole('region', { name, exact: true })
  const dialog = () => page.getByRole('dialog')
  const save = async () => {
    await dialog().getByRole('button', { name: '保存连接' }).click()
    await dialog().waitFor({ state: 'hidden' })
  }
  const relays = () => region('中转站与自定义接口')
  const legacy = () => relays().getByRole('article', { name: legacyRelay.Name })
  await button('设置').click()
  await legacy().waitFor()
  assert.deepEqual(await legacy().getByRole('list', { name: '图片模型' }).locator('code').allTextContents(),
    [legacyRelay.Model, ...legacyRelay.Models])
  assert.equal(await region('内置官网').getByRole('article').count(), 0)

  await button('添加模型服务').click()
  await dialog().getByLabel('连接名称').fill('图片直连')
  await dialog().getByRole('button', { name: '使用 OpenAI 官方地址' }).click()
  assert.match(await dialog().getByLabel('服务分组').locator('option:checked').innerText(), /厂商直连/)
  await dialog().getByLabel('模型 ID', { exact: true }).fill('image-direct')
  await shot('添加模型服务', dialog())
  await save()
  await region('厂商直连').getByRole('article', { name: '图片直连' }).waitFor()

  await button('编辑 图片直连').click()
  await dialog().getByLabel('服务分组').selectOption('relay')
  await save()
  await relays().getByRole('article', { name: '图片直连' }).waitFor()
  assert.equal(await region('厂商直连').count(), 0)
  assert.equal(await legacy().getByText('image-direct', { exact: true }).count(), 0)
  page = await restart()
  const services = page.getByLabel('生成服务', { exact: true })
  assert.deepEqual(await services.locator('optgroup[label="内置官网"] option').allTextContents(), ['AIGC 创作空间 · 官网'])
  assert.deepEqual(await services.locator('optgroup[label="中转站与自定义接口"] option').allTextContents(), [legacyRelay.Name, '图片直连'])

  await button('设置').click()
  await button('编辑 图片直连').click()
  assert.equal(await dialog().getByLabel('服务分组').inputValue(), 'relay')
  await dialog().getByLabel('服务分组').selectOption('auto')
  await save()
  await region('厂商直连').getByRole('button', { name: '移除 图片直连' }).click()
  await button('移除连接').click()
  await region('厂商直连').waitFor({ state: 'detached' })

  await button('添加模型服务').click()
  await dialog().getByLabel('接口协议').selectOption('comfy-image')
  assert.match(await dialog().getByLabel('服务分组').locator('option:checked').innerText(), /本地与自托管/)
  await dialog().getByLabel('模型 ID', { exact: true }).fill('studio.safetensors')
  await save()
  await region('本地与自托管').getByRole('button', { name: '移除 本机 ComfyUI' }).click()
  await button('移除连接').click()
  await region('本地与自托管').waitFor({ state: 'detached' })

  await region('内置官网').getByRole('button', { name: '配置官网 Key' }).click()
  assert.equal(await dialog().getByLabel('服务分组').count(), 0)
  await dialog().getByLabel('API Key').fill('offline-ui-fixture')
  await save()
  await region('内置官网').getByText('Key 已配置').waitFor()
  await shot('模型服务设置', page.locator('.media-preferences'))
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  for (const width of [320, 760, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 772 })
    assert.ok(await region('我的模型服务').evaluate(el => el.scrollWidth <= el.clientWidth + 1), `connections overflow at ${width}px`)
  }
  await page.setViewportSize(viewport)
  await legacy().getByRole('button', { name: `移除 ${legacyRelay.Name}` }).click()
  await button('移除连接').click()
  await region('我的模型服务').getByText(/还没有添加服务/).waitFor()
  assert.equal(await region('内置官网').getByText('Key 已配置').count(), 1)
  console.log('Connection groups passed: legacy nesting, per-service models, automatic and manual grouping, restart, removal and responsive layout.')
}
