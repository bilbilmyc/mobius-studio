import assert from 'node:assert/strict'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const publicFrame = 'https://media.example.invalid/keyframes/tail.png'
const pixel = 'data:image/png;base64,'
export function creationMock({ clip, still, png }) {
  const calls = [],
    failOnce = new Set()
  const first = pixel + png.toString('base64')
  async function handle(req, res, bytes) {
    const url = req.url,
      key =
        req.headers.authorization ||
        req.headers['x-api-key'] ||
        req.headers['x-goog-api-key'] ||
        req.headers['x-auth-token']
    if (
      url !== '/v1/tasks/matrix-official' &&
      !url.startsWith('/v1/matrix/') &&
      !String(key).includes('matrix-key')
    )
      return false
    const isForm = req.headers['content-type']?.startsWith('multipart/')
    const body = !isForm && bytes.length ? JSON.parse(bytes) : {}
    const form = isForm
      ? await new Response(bytes, {
          headers: { 'content-type': req.headers['content-type'] },
        }).formData()
      : null
    function reply(v, status = 200) {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(v))
      return true
    }
    const files = async (name) =>
      Promise.all(
        form.getAll(name).map(async (f) => ({
          name: f.name,
          bytes: Buffer.from(await f.arrayBuffer()),
        })),
      )
    calls.push({ method: req.method, url })
    if (url === '/v1/models') {
      assert.equal(req.method, 'GET')
      assert.equal(req.headers['x-api-key'], 'matrix-key')
      return reply({ data: [{ id: 'frame-model' }] })
    }
    if (url === '/v1/upload/presign')
      return reply({
        code: 200,
        data: {
          upload_url: new URL('/put', still).href,
          path: 'saved/' + body.filename,
          required_headers: { 'Content-Type': body.content_type },
        },
      })
    if (url === '/v1/tasks/create') {
      assert.equal(body.config_values.mode, 'first_last')
      assert.equal(body.config_values.duration, 4)
      assert.equal(body.config_values.ratio, '16:9')
      assert.equal(body.priority, 0)
      assert.deepEqual(body.image_path, ['saved/old.png', publicFrame])
      return reply({ code: 200, data: { task_id: 'matrix-official' } })
    }
    if (url === '/v1/tasks/matrix-official') {
      assert.equal(req.headers['x-auth-token'], undefined)
      return reply({
        code: 200,
        data: { status: 'completed', result_oss_url: clip },
      })
    }
    if (url === '/v1/images/edits') {
      if (form) {
        assert.equal(form.get('quality'), 'high')
        assert.equal(form.get('size'), '1344x768')
        if (form.has('image[]')) {
          const [a, b] = await files('image[]')
          assert.equal(a.name, 'old.png')
          assert.equal(b.name, 'end.png')
          assert.deepEqual(a.bytes, png)
          assert.notDeepEqual(a.bytes, b.bytes)
        } else {
          assert.deepEqual((await files('image'))[0].bytes, png)
        }
      } else {
        assert.deepEqual(body.images, [
          { image_url: first },
          { image_url: publicFrame },
        ])
      }
      return reply({ data: [{ url: still }] })
    }
    if (url === '/v1/videos') {
      assert.equal(form.get('seconds'), '8')
      assert.equal(form.has('input_reference'), false)
      return reply({ id: 'matrix-movie' })
    }
    if (url === '/v1/videos/matrix-movie')
      return reply({ status: 'completed', video_url: clip })
    if (url === '/v1/contents/generations/tasks') {
      const [, a, b, c] = body.content
      assert.equal(body.resolution, '480p')
      if (body.prompt || body.content[0].text === '首尾') {
        assert.equal(body.ratio, 'adaptive')
        assert.deepEqual([a.role, b.role], ['first_frame', 'last_frame'])
        assert.equal(a.image_url.url, first)
        assert.equal(b.image_url.url, publicFrame)
      } else {
        assert.equal(body.ratio, '9:16')
        assert.deepEqual(
          [a.role, b.role, c.role],
          ['reference_image', 'reference_video', 'reference_audio'],
        )
        assert.ok(b.video_url.url.startsWith('data:video/mp4;base64,'))
        assert.ok(c.audio_url.url.startsWith('data:audio/wav;base64,'))
      }
      return reply({ id: 'matrix-ark' })
    }
    if (url === '/v1/contents/generations/tasks/matrix-ark')
      return reply({ status: 'succeeded', content: { video_url: clip } })
    if (url.includes('/services/aigc/')) {
      if (body.model === 'wan-image') {
        assert.equal(url, '/v1/services/aigc/image-generation/generation')
        const items = body.input.messages[0].content
        assert.equal(items[0].image, first)
        assert.equal(items[1].image, publicFrame)
        assert.equal(items[2].text, '编辑')
      } else if (body.model === 'wan-i2v-video') {
        assert.equal(url, '/v1/services/aigc/video-generation/video-synthesis')
        assert.equal(body.input.img_url, first)
        assert.equal(body.parameters.duration, 7)
        assert.equal(body.parameters.resolution, '720P')
      } else {
        assert.equal(url, '/v1/services/aigc/image2video/video-synthesis')
        assert.equal(body.input.first_frame_url, first)
        assert.equal(body.input.last_frame_url, publicFrame)
        assert.equal(body.parameters.duration, 5)
        assert.equal(body.parameters.resolution, '480P')
      }
      return reply({ output: { task_id: 'matrix-' + body.model } })
    }
    if (url.startsWith('/v1/tasks/matrix-wan'))
      return reply({
        output: {
          task_status: 'SUCCEEDED',
          video_url: clip,
          results: [{ url: still }],
        },
      })
    if (url === '/v1/matrix/frame-model/transition') {
      assert.equal(req.headers['x-api-key'], 'matrix-key')
      assert.equal(body.start, first)
      assert.equal(body.end, publicFrame)
      assert.equal(body.width, 1344)
      assert.equal(body.height, 768)
      assert.equal(body.ratio, '7:4')
      assert.equal(body.resolution, '720p')
      assert.equal(body.seconds, 7)
      assert.equal(body.seed, 64)
      return reply({ data: { id: 'transition' } })
    }
    if (url === '/v1/matrix/status/transition')
      return reply({ data: { status: 'completed', url: clip } })
    if (url === '/v1/matrix/edit') {
      assert.equal(req.headers['x-goog-api-key'], 'matrix-key')
      const [a, b] = await files('source[]')
      assert.deepEqual(a.bytes, png)
      assert.equal(b.name, 'end.png')
      assert.equal(form.get('scale'), '2')
      return reply({ data: [{ url: still }] })
    }
    if (url === '/v1/matrix/single') {
      assert.equal(body.input, first)
      return reply({ data: { url: clip } })
    }
    if (url === '/v1/matrix/multi') {
      assert.equal(body.images[0], first)
      assert.ok(body.videos[0].startsWith('data:video/mp4;base64,'))
      assert.ok(body.audios[0].startsWith('data:audio/wav;base64,'))
      return reply({ data: { url: clip } })
    }
    if (url === '/v1/matrix/raw') {
      assert.deepEqual(body.positive, [png.toString('base64')])
      return reply({ data: [{ url: still }] })
    }
    if (url === '/v1/matrix/resume') return reply({ data: { id: 'resume' } })
    if (url === '/v1/matrix/status/resume') {
      if (!failOnce.has(url)) {
        failOnce.add(url)
        return reply({ message: 'status permission required' }, 403)
      }
      return reply({ data: { status: 'completed', url: clip } })
    }
    throw Error('unexpected matrix request ' + url)
  }
  return { handle, calls }
}
export async function exerciseCreation({
  page,
  state,
  record,
  submit,
  done,
  pick,
  picks,
  profile,
  map,
  base,
  temp,
  png,
  mock,
  shot,
  templates,
}) {
  const before = (await state()).jobs.length
  // The second one-pixel PNG has a different color to make swapped file bodies detectable.
  await writeFile(
    path.join(temp, 'end.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQOeEGAAIWASPNNd4GAAAAAElFTkSuQmCC',
      'base64',
    ),
  )
  const end = await pick('image', path.join(temp, 'end.png'))
  const link = await page.evaluate(
    (u) => window.studio.link('image', u),
    publicFrame,
  )
  const cfg = {
    sizes: [],
    seconds: [],
    resolutions: [],
    ratios: [],
    customSize: true,
  }
  const standard = async (proto) =>
    record({ ...profile(proto, 'matrix-key'), controls: cfg })
  const rh = await standard('rh-video'),
    mini = templates.find((t) => t.Key.startsWith('rh-sd20-mini-'))
  await submit(rh, 'video', {
    template: mini.Key,
    config: {
      ...Object.fromEntries(mini.Fields.map((f) => [f.Key, f.Default])),
      mode: 'first_last',
      duration: 4,
      ratio: '16:9',
    },
    assets: [picks.image, link],
  })
  const image = await standard('openai-image')
  for (const refs of [[picks.image], [picks.image, end], [picks.image, link]]) {
    await submit(image, 'image', {
      size: '1344x768',
      config: { mode: 'i2i', quality: 'high' },
      assets: refs,
    })
  }
  const video = await standard('openai-video')
  await submit(video, 'video', { config: { mode: 't2v' }, seconds: 8 })
  const ark = await standard('ark-video')
  await submit(ark, 'video', {
    prompt: '首尾',
    config: { mode: 'first_last', resolution: '480p' },
    size: '16:9',
    seconds: 5,
    assets: [picks.image, link],
  })
  await submit(ark, 'video', {
    prompt: '多参考',
    config: { mode: 'reference', resolution: '480p' },
    size: '9:16',
    seconds: 5,
    assets: [picks.image, picks.video, picks.audio],
  })
  await submit(await standard('wan-image'), 'image', {
    config: { mode: 'i2i' },
    prompt: '编辑',
    size: '2048x2048',
    assets: [picks.image, link],
  })
  await submit(await standard('wan-i2v-video'), 'video', {
    config: { mode: 'first_frame', resolution: '720P' },
    size: 'adaptive',
    seconds: 7,
    assets: [picks.image],
  })
  await submit(await standard('wan-frames-video'), 'video', {
    config: { mode: 'first_last', resolution: '480P' },
    size: 'adaptive',
    seconds: 5,
    assets: [picks.image, link],
  })
  const customMap = {
    ...map,
    submit: 'matrix/resume',
    poll: 'matrix/status/{id}',
    url: 'data.url',
    state: 'data.status',
    id: 'data.id',
    success: 'completed',
    body: '{"prompt":"{{prompt}}"}',
    sizes: ['1344x768'],
    seconds: [7],
    workflows: {
      first_frame: {
        submit: 'matrix/single',
        encoding: 'json',
        body: '{"input":"{{first_frame}}"}',
      },
      reference: {
        submit: 'matrix/multi',
        encoding: 'json',
        body: '{"images":"{{images}}","videos":"{{videos}}","audios":"{{audios}}"}',
      },
    },
  }
  const mapped = await record({
    ...profile('relay-video', 'matrix-key'),
    relay: customMap,
  })
  await submit(mapped, 'video', {
    config: { mode: 'first_frame' },
    size: '1344x768',
    seconds: 7,
    assets: [picks.image],
  })
  await submit(mapped, 'video', {
    config: { mode: 'reference' },
    size: '1344x768',
    seconds: 7,
    assets: [picks.image, picks.video, picks.audio],
  })
  const rawInput = {
    profileId: mapped,
    kind: 'video',
    template: '',
    prompt: '恢复下载',
    config: { mode: 't2v' },
    priority: 0,
    size: '1344x768',
    seconds: 7,
    assets: [],
  }
  const ticket = await page.evaluate((v) => window.studio.start(v), rawInput)
  for (
    let i = 0;
    i < 150 &&
    (await state()).jobs.find((j) => j.id === ticket)?.status !== 'paused';
    i++
  )
    await delay(60)
  assert.equal(
    (await state()).jobs.find((j) => j.id === ticket).status,
    'paused',
  )
  await page.evaluate((id) => window.studio.resume(id), ticket)
  await done(ticket)
  assert.equal(
    mock.calls.filter(
      (c) => c.url === '/v1/matrix/resume' && c.method === 'POST',
    ).length,
    1,
  )
  const edit = {
    ...customMap,
    auth: 'x-goog-api-key',
    poll: '',
    url: 'data.0.url',
    sizes: ['1024x1024'],
    workflows: {
      i2i: {
        submit: 'matrix/edit',
        encoding: 'multipart',
        body: '{"source[]":"{{images}}","scale":2}',
      },
    },
    seconds: [],
  }
  const editId = await record({
    ...profile('relay-image', 'matrix-key'),
    relay: edit,
  })
  await submit(editId, 'image', {
    size: '1024x1024',
    config: { mode: 'i2i' },
    assets: [picks.image, end],
  })
  const rawId = await record({
    ...profile('relay-image', 'matrix-key'),
    relay: {
      ...edit,
      workflows: {
        i2i: {
          submit: 'matrix/raw',
          encoding: 'json',
          body: '{"positive":"{{images_base64}}"}',
        },
      },
    },
  })
  await submit(rawId, 'image', {
    size: '1024x1024',
    config: { mode: 'i2i' },
    assets: [picks.image],
  })
  // Configure a first/last-frame relay via the same editor and generation controls a user sees.
  await page.getByRole('button', { name: '视频', exact: true }).click()
  await page.getByRole('button', { name: '管理模型连接' }).click()
  await page.getByRole('button', { name: '添加模型服务' }).click()
  const dlg = page.getByRole('dialog')
  await dlg.getByLabel('连接名称').fill('关键帧测试站')
  await dlg.getByLabel('接口协议').selectOption('relay-video')
  await dlg.getByLabel('服务根地址').fill(base + '/models')
  await dlg.getByLabel('API Key', { exact: true }).fill('matrix-key')
  await dlg.getByLabel('认证方式').selectOption('x-api-key')
  await dlg.getByRole('button', { name: '获取模型列表' }).click()
  await dlg.getByLabel('从服务商选择模型').selectOption('frame-model')
  await dlg.getByLabel('轮询路径', { exact: true }).fill('matrix/status/{id}')
  await dlg.getByLabel('首尾帧视频', { exact: true }).check()
  await dlg.getByLabel('首尾帧视频提交路径').fill('matrix/{model}/transition')
  await dlg
    .getByLabel('首尾帧视频请求体')
    .fill(
      '{"start":"{{first_frame}}","end":"{{last_frame}}","width":"{{width}}","height":"{{height}}","seconds":"{{seconds}}","ratio":"{{ratio}}","resolution":"{{resolution}}"}',
    )
  await dlg.getByRole('button', { name: '＋ 随机种子' }).click()
  await dlg.getByLabel('可选画幅（逗号分隔）').fill('1024x1024,1344x768')
  await dlg.getByLabel('时长（秒，逗号分隔）').fill('5,7')
  await dlg.locator('summary').filter({ hasText: '模型支持的输出参数' }).click()
  await dlg.getByLabel('分辨率选项').fill('480p,720p')
  await dlg.getByRole('button', { name: '保存连接' }).click()
  await page.getByRole('button', { name: '创作台', exact: true }).click()
  await dlg.waitFor({ state: 'hidden' })
  const expectedConnection = (await state()).profiles.find(
    (p) => p.Name === '关键帧测试站',
  )
  assert.equal(expectedConnection.BaseUrl, base)
  assert.ok(
    expectedConnection.Relay.workflows.first_last.body.includes(
      '{{resolution}}',
    ),
  )
  assert.equal(
    await page.getByLabel('生成服务', { exact: true }).inputValue(),
    expectedConnection.Id,
  )
  await page.getByLabel('创作方式').selectOption('first_last')
  await page.getByLabel('输出尺寸或画幅').selectOption('1344x768')
  const savedProfile = (await state()).profiles.find(
    (p) => p.Name === '关键帧测试站',
  )
  assert.deepEqual(savedProfile.Controls.resolutions, ['480p', '720p'])
  await page.getByLabel('分辨率').selectOption('720p')
  await page.getByLabel('时长（秒）').selectOption('7')
  await page.getByLabel('随机种子').fill('64')
  const last = page.locator('[data-role=last_frame]'),
    first = page.locator('[data-role=first_frame]')
  await last.getByRole('button', { name: '使用链接' }).click()
  await page.getByLabel('HTTPS 素材地址').fill(publicFrame)
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '添加素材' })
    .click()
  await first.getByRole('button', { name: '作品库选图' }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '旧版测试作品' })
    .click()
  await first.locator('.asset-thumb').waitFor()
  await page.getByRole('button', { name: '交换首尾帧' }).click()
  assert.match(await first.innerText(), /tail.png/)
  await page.getByRole('button', { name: '交换首尾帧' }).click()
  assert.match(await first.innerText(), /old.png/)
  const prompt = '测试两张关键帧之间的平滑过渡'
  await page.locator('#prompt').fill(prompt)
  await first.scrollIntoViewIfNeeded()
  await shot('首尾帧中转站')
  await page.getByRole('button', { name: '生成视频', exact: true }).click()
  let saved
  for (let i = 0; i < 150 && !saved; i++) {
    saved = (await state()).jobs.find((j) => j.prompt === prompt)
    if (!saved) await delay(60)
  }
  assert.ok(saved)
  saved = await done(saved.id)
  assert.equal(saved.settings['params.seed'], 64)
  await page.getByRole('group', { name: '最近提交的任务' }).filter({ hasText: prompt }).getByRole('button').click()
  await page.getByRole('button', { name: '复用参数' }).click()
  await first.locator('.asset-thumb').waitFor()
  assert.match(await last.innerText(), /tail.png/)
  assert.equal(await page.getByLabel('随机种子').inputValue(), '64')
  // Local validation rejects unsupported or incomplete inputs before dispatch or billing.
  const count = (await state()).jobs.length
  for (const invalid of [
    {
      ...rawInput,
      profileId: video,
      config: { mode: 'first_last' },
      assets: [picks.image, end],
    },
    {
      ...rawInput,
      profileId: ark,
      config: { mode: 'first_last' },
      assets: [picks.image],
    },
    {
      ...rawInput,
      profileId: saved.profileId,
      config: { mode: 'first_last', 'params.seed': -99 },
      assets: [picks.image, link],
    },
  ]) {
    await assert.rejects(page.evaluate((v) => window.studio.start(v), invalid))
  }
  assert.equal((await state()).jobs.length, count)
  console.log(
    'Media matrix passed: image edits, text/video, reference sets, ordered frames, multipart/JSON, model parameters and resumable polling',
  )
  return count - before
}
