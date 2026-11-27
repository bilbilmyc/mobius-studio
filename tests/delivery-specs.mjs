import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

function cli(name, args) {
  const result = spawnSync(name, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16_000_000 })
  assert.equal(result.status, 0, result.stderr || String(result.error))
  return result.stdout
}
const probe = file => JSON.parse(cli('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file])).streams
const packets = file => JSON.parse(cli('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_packets',
  '-show_data_hash', 'sha256', '-show_entries', 'packet=data_hash,pts_time', '-of', 'json', file])).packets
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex')

// Optional originals let the same desktop checks run against a previously downloaded official result.
export async function exerciseDelivery({ data, restart, shot, record, base, calls, templates, done }) {
  const dir = path.join(data, '作品'), out = path.join(dir, '导出')
  const image = path.join(dir, '交付样片.png'), video = path.join(dir, '交付样片.mp4'), webm = path.join(dir, '交付样片.webm')
  const generate = args => cli('ffmpeg', ['-loglevel', 'error', '-y', ...args])
  if (process.env.MOBIUS_QA_IMAGE) await copyFile(process.env.MOBIUS_QA_IMAGE, image)
  else generate(['-f', 'lavfi', '-i', 'testsrc2=s=128x192', '-frames:v', '1', image])
  if (process.env.MOBIUS_QA_VIDEO) await copyFile(process.env.MOBIUS_QA_VIDEO, video)
  else generate(['-f', 'lavfi', '-i', 'testsrc2=s=96x64:d=1', '-f', 'lavfi', '-i', 'sine=d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '2', '-c:a', 'aac', '-shortest', video])
  generate(['-f', 'lavfi', '-i', 'testsrc2=s=96x64:d=1', '-f', 'lavfi', '-i', 'sine=d=1',
    '-c:v', 'libvpx-vp9', '-c:a', 'libopus', '-shortest', webm])
  const quiet = path.join(dir, '交付无声样片.mp4')
  cli('ffmpeg', ['-loglevel', 'error', '-y', '-i', video, '-map', '0:v:0', '-c', 'copy', quiet])
  const fixtures = [image, video, webm, quiet]
  const originals = await Promise.all(fixtures.map(hash))
  const names = ['交付测试竖图', '交付测试有声 MP4', '交付测试有声 WebM', '交付测试无声音轨']
  for (const [i, file] of fixtures.entries()) {
    const Id = randomUUID().replaceAll('-', '')
    await writeFile(path.join(data, 'tasks', Id + '.json'), JSON.stringify({ Id, ProtocolId: i ? 'rh-video' : 'rh-image',
      Prompt: names[i], Model: templates.find(t => t.Video === !!i).Key, Size: '9:16', Seconds: i ? 4 : 0, FileName: path.basename(file),
      SiteOptions: { Config: i ? { ratio: '9:16', generate_audio: false, duration: 4 } : { aspect: '9:16' } },
      Status: 'done', CreatedUtc: new Date(Date.now() + i * 1000).toISOString() }))
  }
  const page = await restart()
  async function open(i) {
    await page.getByRole('button', { name: '作品库', exact: true }).click()
    await page.getByLabel('搜索作品').fill(names[i])
    await page.locator('.card').filter({ hasText: names[i] }).dblclick()
  }
  await open(0)
  await page.getByText(/原文件画幅与请求不同/).waitFor()
  const [im] = probe(image)
  await page.getByText('实际图片 ' + im.width + ' × ' + im.height, { exact: false }).waitFor()
  await page.getByRole('button', { name: '按尺寸导出', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '按尺寸导出图片' })
  const multiple = Math.floor(Math.min(im.width / 9, im.height / 16))
  assert.equal(await dialog.getByLabel('宽度（像素）').inputValue(), String(9 * multiple))
  assert.equal(await dialog.getByLabel('高度（像素）').inputValue(), String(16 * multiple))
  await shot('按请求画幅导出', dialog)
  await dialog.getByRole('button', { name: '导出到作品目录' }).click()
  await dialog.waitFor({ state: 'hidden' })
  const targetImage = path.join(out, (await readdir(out)).find(name => name.endsWith('-交付样片-' + 9 * multiple + 'x' + 16 * multiple + '.png')))
  const [target] = probe(targetImage)
  assert.deepEqual([target.width, target.height], [9 * multiple, 16 * multiple])
  for (const i of [1, 2]) {
    await open(i)
    await page.getByText(/实际视频.*1 条音轨/).waitFor()
    await page.getByText(/上游返回的视频仍含音轨/).waitFor()
    assert.ok(await page.locator('.canvas video').evaluate(v => v.muted))
    if (i === 1) await shot('上游音轨提示', page.locator('.output-specs'))
    await page.getByRole('button', { name: '导出无音轨副本' }).click()
    const message = page.getByRole('status').filter({ hasText: '无音轨副本已保存到' })
    await message.or(page.locator('.output-specs [role=alert]')).waitFor()
    assert.equal(await page.locator('.output-specs [role=alert]').allTextContents().then(s => s.join('')), '')
    const dest = (await message.innerText()).split('无音轨副本已保存到 ')[1]
    const streams = probe(dest)
    assert.deepEqual(streams.map(s => s.codec_type), ['video'])
    const frames = packets(fixtures[i]), result = packets(dest)
    assert.deepEqual(result.map(p => p.data_hash), frames.map(p => p.data_hash), 'Every encoded frame must be preserved')
    for (let n = 0; n < frames.length; n++) assert.ok(Math.abs(+result[n].pts_time - +frames[n].pts_time) < 0.002)
    if (i === 1) {
      if (process.env.MOBIUS_QA_OUTPUT) {
        await mkdir(process.env.MOBIUS_QA_OUTPUT, { recursive: true })
        await copyFile(dest, path.join(process.env.MOBIUS_QA_OUTPUT, '灯塔初亮-无音轨.mp4'))
        await copyFile(targetImage, path.join(process.env.MOBIUS_QA_OUTPUT, '灯塔初亮-9比16.png'))
      }
    }
  }
  await open(3)
  await page.getByText(/实际视频.*无音轨/).waitFor()
  assert.equal(await page.getByRole('button', { name: '导出无音轨副本' }).count(), 0)
  assert.deepEqual(await Promise.all(fixtures.map(hash)), originals)

  const profileId = await record({ name: '交付规格模拟站', protocol: 'rh-image', base: new URL(base).origin + '/delivery/v1',
    model: templates[0].Key, key: 'delivery-fixture' })
  await page.getByRole('button', { name: '图片', exact: true }).click()
  await page.getByLabel('生成服务').selectOption(profileId)
  await page.getByLabel('同模型候选数').selectOption('4')
  await page.getByText('4 次独立生成请求', { exact: true }).waitFor()
  assert.doesNotMatch(await page.locator('aside.settings').innerText(), /[¥￥]|预估|价格|结算/)
  await page.getByLabel('同模型候选数').selectOption('1')
  const gpt = templates.find(t => !t.Video && t.Key.includes('t2i')), banana = templates.find(t => !t.Video && t.Key.includes('banana'))
  for (const [main, second, ratio, peerRatio] of [[gpt, banana, '16:9', '16:9'], [banana, gpt, '4:3', '9:16']]) {
    await page.getByLabel('官网模板').selectOption(main.Key)
    await page.getByRole('combobox', { name: /^画幅/ }).selectOption(ratio)
    await page.getByRole('combobox', { name: /^分辨率/ }).selectOption('2k')
    await page.getByLabel('对比模型').selectOption(JSON.stringify([profileId, second.Key]))
    const summary = await page.locator('.generate-foot small').filter({ hasText: '2 个生成任务' }).innerText()
    assert.ok(summary.split('对比模型')[1].includes(peerRatio + ' · 2k · 普通队列'))
    assert.doesNotMatch(summary, /[¥￥]|预估|价格|结算/)
    assert.equal(summary.includes('两侧参数不同'), ratio !== peerRatio)
    const prompt = '规格对比 ' + ratio
    await page.locator('#prompt').fill(prompt)
    await page.getByRole('button', { name: '用两个模型生成', exact: true }).click()
    const group = page.getByRole('dialog', { name: /双模型/ })
    await group.locator('img').nth(1).waitFor()
    const captured = calls.filter(c => c.extra_data.text === prompt)
    assert.equal(captured.length, 2)
    for (const [t, expected] of [[main, ratio], [second, peerRatio]]) {
      const body = captured.find(c => c.template_key === t.Key)
      assert.deepEqual(body.config_values, { aspect: expected, resolution: '2k' })
      assert.equal(body.priority, 0)
    }
    const ids = (await page.evaluate(() => window.studio.state())).jobs.filter(j => j.prompt === prompt)
    assert.equal(ids.length, 2)
    for (const j of ids) assert.equal((await done(j.id)).site.config.aspect, j.model === main.Key ? ratio : peerRatio)
    await group.getByRole('button', { name: '关闭', exact: true }).click()
  }
  console.log('Delivery passed: exact image ratio, lossless MP4/WebM, original hashes, two compatible and mismatched model submissions')
}
