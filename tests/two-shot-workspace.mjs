import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import path from 'node:path'

export function shotFixture(temp) {
  const assets = ['红伞', '蓝桥'].map(name => path.join(temp, name + '.png'))
  for (const [i, file] of assets.entries()) {
    const result = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i',
      'color=c=' + (i ? 'steelblue' : 'firebrick') + ':s=160x96', '-frames:v', '1', file])
    assert.equal(result.status, 0, result.stderr.toString())
  }
  const calls = []
  return { assets, calls, async handle(req, res, bytes) {
    if (!req.url.startsWith('/compare-')) return false
    assert.ok(req.url.endsWith('/images/edits'), req.url)
    const form = await new Response(bytes, { headers: { 'Content-Type': req.headers['content-type'] } }).formData()
    const model = form.get('model'), prompt = form.get('prompt')
    const images = form.getAll('image').concat(form.getAll('image[]'))
    const imageBytes = await Promise.all(images.map(async image => Buffer.from(await image.arrayBuffer())))
    calls.push({ model, prompt, images: imageBytes, size: form.get('size') })
    const png = await readFile(assets[model === 'model-A' ? 0 : 1])
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
    return true
  } }
}

export async function exerciseTwoShots({ page, base, fixture, record, state, shot, restart }) {
  await page.evaluate(async () => {
    const { storage } = await window.studio.settings()
    if (storage.automatic) await window.studio.saveStorage({ ...storage, automatic: false }, '')
  })
  const button = name => page.getByRole('button', { name, exact: true })
  const dialog = name => page.getByRole('dialog', { name })
  const prompt = () => page.locator('#prompt')
  const scene = name => page.locator('.shot-list > li').filter({ has: page.getByRole('heading', { name, exact: true }) })
  const fixtures = await Promise.all(fixture.assets.map(p => readFile(p)))
  const root = new URL(base).origin
  const stream = await record({ name: '分镜模拟甲', base: root + '/compare-a', model: 'model-A', models: ['model-B'],
    key: 'test-only', protocol: 'openai-image' })
  const other = await record({ name: '分镜模拟乙', base: root + '/compare-b', model: 'model-C', key: 'test-only', protocol: 'openai-image' })
  async function pick(index, label = /选择本地文件/) {
    await page.evaluate(file => {
      const saved = window.studio.pick
      window.studio.pick = (kind) => { window.studio.pick = saved; return window.studio.drop(kind, [file]) }
    }, fixture.assets[index])
    await page.getByRole('button', { name: label }).click()
    await page.locator('.file-row').filter({ hasText: path.basename(fixture.assets[index]) }).first().waitFor()
  }
  const title = '雾岸 · 双镜实测'
  await button('剧本').click()
  await button('手写或粘贴分镜').click()
  await page.getByLabel('剧本标题').fill(title)
  await page.getByLabel('分镜正文', { exact: true }).fill('镜头 1 雨中红伞\n画面：红伞走过街口\n台词：雨还没停。\n镜头 2 清晨蓝桥\n画面：蓝桥横跨河面')
  await button('拆分并预览').click()
  const editor = dialog('手工分镜')
  assert.equal(await editor.locator('fieldset').count(), 2)
  await editor.locator('fieldset').first().getByRole('button', { name: '复制' }).click()
  await editor.locator('fieldset').nth(1).getByRole('button', { name: '移除' }).click()
  await editor.locator('fieldset').first().getByRole('button', { name: '插入一镜' }).click()
  await editor.locator('fieldset').nth(1).getByRole('button', { name: '移除' }).click()
  await button('保存剧本').click()
  await page.getByRole('heading', { name: title }).waitFor()
  const script = () => page.evaluate(async title => (await window.studio.scripts()).find(s => s.title === title), title)
  const original = await script()
  const shotNames = ['雨中红伞', '清晨蓝桥'], prompts = ['红伞从画面右侧进入', '清晨薄雾笼罩蓝桥']
  const sizes = ['1024x1536', '1536x1024'], altModels = ['model-B', 'model-C']
  const secondary = [JSON.stringify([stream, 'model-B']), JSON.stringify([other, 'model-C'])]
  const winners = []
  for (let i = 0; i < 2; i++) {
    await scene(shotNames[i]).getByRole('button', { name: '用于生图' }).click()
    await page.getByLabel('生成服务').selectOption(stream)
    await page.getByLabel('创作方式').selectOption('i2i')
    assert.equal(await page.locator('.file-row').count(), 0, 'A new shot inherited another shot’s reference')
    await pick(i)
    await prompt().fill(prompts[i])
    await page.getByLabel('输出尺寸或画幅').selectOption(sizes[i])
    await page.getByRole('combobox', { name: /^对比模型/ }).selectOption(secondary[i])
    await button('用两个模型生成').click()
    const compare = dialog('双模型对比')
    await compare.locator('img').nth(1).waitFor()
    await page.waitForFunction(() => [...document.querySelectorAll('.comparison-grid img')].filter(img => img.naturalWidth === 160).length === 2)
    const columns = compare.getByRole('region')
    assert.match(await columns.nth(0).innerText(), /model-A/)
    assert.ok((await columns.nth(1).innerText()).includes(altModels[i]))
    const chosen = 1 - i
    await columns.nth(chosen).getByRole('button', { name: '选为定稿' }).click()
    await columns.nth(chosen).getByRole('button', { name: '已定稿', pressed: true }).waitFor()
    if (!i) await shot('双模型并排定稿')
    const saved = await script()
    const winner = saved.finals[original.scenes[i].id].image
    const jobs = (await state()).jobs.filter(j => j.shot?.sceneId === original.scenes[i].id && j.prompt === prompts[i])
    assert.equal(jobs.length, 2)
    assert.equal(jobs.find(j => j.id === winner).model, chosen ? altModels[i] : 'model-A')
    for (const j of jobs) assert.deepEqual(await readFile(j.mediaPath), fixtures[j.model === 'model-A' ? 0 : 1])
    winners.push(winner)
    await compare.getByRole('button', { name: '关闭' }).click()
    await prompt().fill(prompts[i] + '，未提交修订')
    await button('剧本').click()
  }
  assert.equal(fixture.calls.length, 4)
  for (const [i, prompt] of prompts.entries()) {
    const received = fixture.calls.filter(c => c.prompt === prompt)
    assert.deepEqual(received.map(c => c.model).sort(), ['model-A', altModels[i]])
    for (const c of received) {
      assert.deepEqual(c.images, [fixtures[i]])
      assert.equal(c.size, sizes[i])
    }
  }
  await button('编辑剧本').click()
  await dialog('编辑剧本').locator('fieldset').nth(1).getByRole('button', { name: '上移' }).click()
  await button('保存剧本').click()
  await dialog('编辑剧本').waitFor({ state: 'hidden' })
  const reordered = await script()
  assert.deepEqual(reordered.scenes.map(s => s.id), original.scenes.map(s => s.id).reverse())
  await scene(shotNames[1]).getByRole('button', { name: '用于视频' }).click()
  await page.getByLabel('生成服务').selectOption('@site')
  await page.getByLabel('创作方式').selectOption('first_last')
  await pick(1, '首帧选择本地文件'); await pick(0, '尾帧选择本地文件')
  await prompt().fill('蓝桥运镜')
  await page.getByRole('button', { name: '展开编辑' }).click()
  await page.getByLabel('完整提示词').fill('取消的修改')
  await page.getByLabel('完整提示词').press('Escape')
  assert.equal(await prompt().inputValue(), '蓝桥运镜')
  await page.getByRole('button', { name: '展开编辑' }).click()
  await page.getByLabel('完整提示词').fill('蓝桥运镜，关窗前最后输入')
  page = await restart()
  await Promise.all(fixture.assets.map(p => unlink(p)))
  await page.getByRole('button', { name: /继续上次分镜/ }).click()
  assert.equal(await prompt().inputValue(), '蓝桥运镜，关窗前最后输入')
  assert.match(await page.locator('[data-role="first_frame"] .file-row').innerText(), /蓝桥/)
  assert.match(await page.locator('[data-role="last_frame"] .file-row').innerText(), /红伞/)
  await page.getByRole('img', { name: '视频首帧预览' }).waitFor()
  for (const [i, name] of shotNames.entries()) {
    await button('剧本').click()
    await scene(name).getByRole('button', { name: '用于生图' }).click()
    assert.equal(await prompt().inputValue(), prompts[i] + '，未提交修订')
    assert.equal(await page.getByLabel('创作方式').inputValue(), 'i2i')
    assert.equal(await page.getByLabel('输出尺寸或画幅').inputValue(), sizes[i])
    assert.equal(await page.getByRole('combobox', { name: /^对比模型/ }).inputValue(), secondary[i])
    assert.match(await page.locator('.bound-shot').innerText(), new RegExp('第 ' + (2 - i) + ' 镜'))
    assert.equal(await page.locator('.file-row').count(), 1)
    assert.ok((await page.locator('.file-row').innerText()).includes(path.basename(fixture.assets[i])))
    await page.waitForFunction(() => document.querySelector('.file-row img')?.naturalWidth === 160)
    await button('剧本').click()
    await scene(name).getByRole('button', { name: /双模型对比/ }).click()
    await dialog('双模型对比').getByRole('button', { name: '已定稿', pressed: true }).waitFor()
    await dialog('双模型对比').getByRole('button', { name: '关闭' }).click()
  }
  const reopened = await script()
  assert.deepEqual(original.scenes.map(s => reopened.finals[s.id].image), winners)
  assert.equal(fixture.calls.length, 4, 'Reopening must not submit new requests')
  console.log('Two-shot desktop acceptance passed: 4 model requests with exact per-shot image bytes, independent image/video drafts, reordered stable shot IDs and both finals restored after a normal close and new process.')
}
