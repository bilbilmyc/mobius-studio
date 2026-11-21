import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export function comfyFixture(png) {
  const graphs = [],
    lookups = new Map()
  let uploaded = 0,
    downloaded = 0
  return {
    handle(req, res, bytes) {
      const url = new URL(req.url, 'http://localhost')
      if (!url.pathname.startsWith('/comfy/')) return false
      assert.equal(req.headers.authorization, 'Bearer comfy-fixture')
      const endpoint = url.pathname.slice('/comfy/'.length)
      function json(value) {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(value))
      }
      if (endpoint === 'object_info/CheckpointLoaderSimple') {
        json({
          CheckpointLoaderSimple: {
            input: { required: { ckpt_name: [['starter.safetensors', 'studio.safetensors']] } },
          },
        })
      } else if (endpoint === 'upload/image') {
        assert.equal(req.method, 'POST')
        assert.match(req.headers['content-type'], /multipart/)
        assert.ok(bytes.includes(png))
        uploaded++
        json({ name: '参考 图.png', subfolder: 'mobius', type: 'input' })
      } else if (endpoint === 'prompt') {
        assert.equal(req.method, 'POST')
        const { prompt, client_id } = JSON.parse(bytes)
        assert.equal(prompt['1'].inputs.ckpt_name, 'studio.safetensors')
        assert.equal(prompt['7'].class_type, 'SaveImage')
        assert.match(client_id, /^[a-f\d]{32}$/)
        if (graphs.length === 0) {
          assert.equal(prompt['4'].class_type, 'EmptyLatentImage')
          assert.equal(prompt['4'].inputs.width, 512)
        } else {
          assert.equal(prompt['4'].class_type, 'VAEEncode')
          assert.equal(prompt['8'].inputs.image, 'mobius/参考 图.png')
          assert.equal(prompt['9'].inputs.height, 512)
          assert.equal(prompt['5'].inputs.denoise, 0.45)
        }
        assert.equal(prompt['2'].inputs.text, 'local workflow')
        assert.equal(prompt['3'].inputs.text, 'noise')
        assert.equal(prompt['5'].inputs.steps, 12)
        assert.equal(prompt['5'].inputs.seed, 42)
        graphs.push(prompt)
        json({ prompt_id: 'job-' + graphs.length })
      } else if (endpoint.startsWith('history/')) {
        const id = endpoint.slice('history/'.length),
          count = lookups.get(id) ?? 0
        lookups.set(id, count + 1)
        json(
          count === 0
            ? {}
            : {
                [id]: {
                  status: { completed: true, status_str: 'success' },
                  outputs: {
                    7: {
                      images: [{ filename: '镜头 #1.png', subfolder: 'chapter 1', type: 'output' }],
                    },
                  },
                },
              },
        )
      } else if (endpoint === 'queue') {
        json({ queue_running: [[0, 'job-' + graphs.length]], queue_pending: [] })
      } else if (endpoint === 'view') {
        assert.equal(url.searchParams.get('filename'), '镜头 #1.png')
        assert.equal(url.searchParams.get('type'), 'output')
        assert.equal(url.searchParams.get('subfolder'), 'chapter 1')
        downloaded++
        res.setHeader('Content-Type', 'image/png')
        res.end(png)
      } else throw Error('Unexpected ComfyUI endpoint ' + endpoint)
      return true
    },
    check() {
      assert.equal(uploaded, 1)
      assert.equal(downloaded, 2)
      assert.equal(graphs.length, 2)
    },
  }
}

export async function exerciseComfy({ page, base, done, shot, fixture }) {
  const button = (name) => page.getByRole('button', { name, exact: true })
  await button('设置').click()
  await button('图片与视频').click()
  await button('添加模型服务').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('接口协议').selectOption('comfy-image')
  await dialog.getByLabel('服务根地址').fill(new URL('/comfy', base).href)
  await dialog.getByLabel('API Key', { exact: true }).fill('comfy-fixture')
  await dialog.getByRole('button', { name: '获取模型列表' }).click()
  await dialog.getByLabel('从服务商选择模型').selectOption('studio.safetensors')
  await dialog.getByRole('button', { name: '保存连接' }).click()
  await dialog.waitFor({ state: 'hidden' })
  await button('创作台').click()
  await page.locator('#prompt').fill('local workflow')
  await page.getByText('采样参数', { exact: true }).click()
  await page.getByLabel('采样步数').fill('12')
  await page.getByLabel('随机种子').fill('42')
  await page.getByLabel('反向提示词').fill('noise')
  await shot('ComfyUI本地生成')
  for (const [i, mode] of ['t2i', 'i2i'].entries()) {
    await page.getByLabel('创作方式').selectOption(mode)
    if (mode === 'i2i') {
      await button('作品库选图').click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /旧版测试作品/ })
        .click()
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      await page.getByLabel('重绘强度').fill('0.45')
      assert.equal(await page.getByLabel('重绘强度').inputValue(), '0.45')
    }
    await button('生成图片').click()
    await page.waitForFunction(
      async (n) =>
        (await window.studio.state()).jobs.filter((j) => j.protocol === 'comfy-image').length === n,
      i + 1,
    )
    const j = await page.evaluate(
      async (mode) =>
        (await window.studio.state()).jobs.find(
          (j) => j.protocol === 'comfy-image' && j.settings.mode === mode,
        ),
      mode,
    )
    assert.ok(j, 'Expected ComfyUI mode '+mode+'; persisted '+JSON.stringify(await page.evaluate(async()=>(await window.studio.state()).jobs.filter(j=>j.protocol==='comfy-image').map(j=>({mode:j.settings?.mode,prompt:j.prompt,status:j.status})))) )
    assert.equal((await done(j.id)).file, true)
  }
  fixture.check()
}

const galleryId = (index) => 'a240' + index.toString(16).padStart(28, '0')

export async function seedGallery(data) {
  const stripe = Buffer.alloc(6 * 4 * 4)
  for (let pixel = 0; pixel < 24; pixel++) {
    const edge = pixel % 6 === 0 || pixel % 6 === 5
    stripe.set(edge ? [255, 0, 0, 255] : [0, 255, 0, 255], pixel * 4)
  }
  const samples = [
    ['stripe.png', '6x4', stripe],
    ['alpha.png', '1x2', Buffer.from([200, 0, 0, 128, 0, 0, 240, 255])],
  ]
  for (const [name, size, bytes] of samples) {
    const encoded = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'rawvideo',
        '-pixel_format',
        'rgba',
        '-video_size',
        size,
        '-i',
        'pipe:0',
        '-frames:v',
        '1',
        '-y',
        path.join(data, '作品', name),
      ],
      { input: bytes },
    )
    assert.equal(encoded.status, 0, encoded.stderr?.toString())
  }
  await Promise.all(
    Array.from({ length: 120 }, (_, i) => {
      const id = galleryId(i)
      const j = {
        Id: id,
        Status: 'done',
        ProtocolId: 'openai-image',
        ProfileName: '回归服务',
        Model: 'gallery-240',
        FileName: samples[i]?.[0] ?? 'old.png',
        Prompt: '离线作品 ' + i,
        CreatedUtc: new Date(1600000000000 + i).toISOString(),
      }
      return writeFile(path.join(data, 'tasks', id + '.json'), JSON.stringify(j))
    }),
  )
}

async function checkExportPixels(page) {
  const render = (i, width, height, fit) =>
    page.evaluate(
      ({ id, width, height, fit }) => window.studio.exportSized(id, { width, height, fit }, false),
      { id: galleryId(i), width, height, fit },
    )
  const decode = (result) => {
    assert.ok(result.path)
    const read = spawnSync('ffmpeg', [
      '-v',
      'error',
      '-i',
      result.path,
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgba',
      '-f',
      'rawvideo',
      'pipe:1',
    ])
    assert.equal(read.status, 0, read.stderr?.toString())
    return [...read.stdout]
  }
  const crop = await render(0, 1, 1, 'crop')
  assert.deepEqual(
    decode(crop),
    [0, 255, 0, 255],
    'Pixels outside the crop bled into the downsample',
  )
  const alpha = decode(await render(1, 1, 2, 'crop'))
  assert.equal(alpha.length, 8)
  ;[200, 0, 0, 128, 0, 0, 240, 255].forEach((v, i) =>
    assert.ok(Math.abs(alpha[i] - v) <= 2, JSON.stringify(alpha)),
  )
  const matte = decode(await render(1, 3, 2, 'contain'))
  assert.deepEqual(matte.slice(0, 4), [0, 0, 0, 255])
  assert.ok(Math.abs(matte[4] - 100) <= 2 && matte[7] === 255, JSON.stringify(matte))
  const fallback = await page.evaluate(async (id) => {
    const original = window.createImageBitmap
    window.createImageBitmap = async () => {
      throw Error('test decoder unavailable')
    }
    try {
      return await window.studio.exportSized(id, { width: 1, height: 1, fit: 'crop' }, false)
    } finally {
      window.createImageBitmap = original
    }
  }, galleryId(0))
  assert.equal(fallback.engine, 'CPU')
  assert.ok(fallback.fallback)
  assert.deepEqual(decode(fallback), [0, 255, 0, 255])
  console.log('Crop, alpha, black matte and CPU recovery passed (' + crop.engine + ')')
}

export async function exerciseGallery({ page, shot }) {
  const button = (name) => page.getByRole('button', { name, exact: true })
  await button('作品库').click()
  const search = page.getByLabel('搜索作品')
  await search.fill('gallery-240')
  await page.getByText('120 条匹配作品').waitFor()
  await page.waitForFunction(() => document.querySelectorAll('.work-card').length === 60)
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.work-card .thumb')].some(
      (el) => el.querySelector('img')?.naturalWidth === 1,
    ),
  )
  await page.waitForFunction(() => {
    const clip = document.querySelector('.gallery').closest('.page-body').getBoundingClientRect()
    return [...document.querySelectorAll('.work-card .thumb')]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.top < clip.bottom && r.bottom > clip.top
      })
      .every((el) => el.querySelector('img')?.naturalWidth > 0)
  })
  let prior = -1,
    stable = 0
  for (let i = 0; i < 20 && stable < 3; i++) {
    await delay(120)
    const count = await page.locator('.work-card img').count()
    stable = count === prior ? stable + 1 : 0
    prior = count
  }
  const counts = await page.evaluate(() => {
    const clip = document.querySelector('.gallery').closest('.page-body').getBoundingClientRect()
    const all = [...document.querySelectorAll('.work-card .thumb')],
      imgs = [...document.querySelectorAll('.work-card img')]
    return {
      mounted: all.length,
      visible: all.filter((e) => {
        const r = e.getBoundingClientRect()
        return r.top < clip.bottom && r.bottom > clip.top
      }).length,
      loaded: imgs.filter((im) => im.complete && im.naturalWidth).length,
      thumbnails: imgs.every((im) => im.src.endsWith('.webp')),
    }
  })
  assert.ok(
    counts.thumbnails && counts.loaded >= counts.visible && counts.loaded < 60,
    JSON.stringify(counts),
  )
  console.log('120-image gallery', JSON.stringify(counts))
  await shot('作品库分页')
  await page.locator('.work-card').last().scrollIntoViewIfNeeded()
  await page.locator('.work-card').last().locator('img').waitFor()
  const pager = page.getByRole('navigation', { name: '作品库分页' })
  await pager.getByRole('button', { name: '下一页' }).click()
  assert.equal(await pager.getByLabel('选择页码').inputValue(), '2')
  await page.locator('.work-card').filter({ hasText: '离线作品 0' }).waitFor({ state: 'attached' })
  assert.equal(
    await page.locator('.gallery').evaluate((el) => el.closest('.page-body').scrollTop),
    0,
  )
  await search.fill(galleryId(119))
  assert.equal(await page.locator('.work-card').count(), 1)
  await search.fill('离线作品 119 gallery-240')
  assert.equal(await page.locator('.work-card').count(), 1)
  await search.fill('gallery-240')
  assert.equal(await pager.getByLabel('选择页码').inputValue(), '1')
  await button('批量导出').click()
  const dialog = page.getByRole('dialog', { name: '批量导出图片' })
  assert.equal(await dialog.getByRole('button', { name: '导出 120 张' }).count(), 1)
  await dialog.getByLabel(/全选当前搜索结果/).uncheck()
  await dialog.getByLabel('离线作品 119', { exact: true }).check()
  await dialog
    .getByRole('navigation', { name: '批量选择分页' })
    .getByRole('button', { name: '下一页' })
    .click()
  await dialog.getByLabel('离线作品 11', { exact: true }).check()
  await dialog.getByLabel('宽度（像素）').fill('160')
  await dialog.getByLabel('高度（像素）').fill('90')
  await dialog.getByRole('button', { name: '导出 2 张' }).click()
  await dialog.getByText(/批量导出完成.*已保存 2 张/).waitFor()
  await shot('批量导出')
  await dialog.getByLabel('关闭', { exact: true }).click()
  await search.fill('找不到这条作品')
  await page.getByText('没有匹配的作品').waitFor()
  await button('清除筛选').click()
  assert.equal(await search.inputValue(), '')
  await page.getByLabel('任务状态').selectOption('attention')
  await search.fill('生成失败用例')
  assert.equal(await page.locator('.work-card').count(), 1)
  await page.getByLabel('任务状态').selectOption('done')
  await page.getByText('没有匹配的作品').waitFor()
  await button('清除筛选').click()
  await checkExportPixels(page)
}
