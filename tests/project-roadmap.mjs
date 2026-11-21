import assert from 'node:assert/strict'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile, rename, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

export async function exerciseRoadmap({ page, data, temp, png, video, templates, restart }) {
  const calls = [],
    records = new Map(),
    pictures = [],
    graphs = [],
    wanCounts = []
  let active = 0,
    maximum = 0,
    cancelled = false
  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const b of req) chunks.push(b)
      const raw = Buffer.concat(chunks),
        url = new URL(req.url, base),
        route = url.pathname
      const json = (v) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(v))
      }
      if (route === '/file.png' || route === '/file.mp4') {
        res.end(route.endsWith('png') ? png : video)
        return
      }
      if (route === '/rh/tasks/create') {
        const body = JSON.parse(raw)
        const number = String(1000 + calls.length)
        calls.push(body)
        active++
        maximum = Math.max(maximum, active)
        records.set(number, {
          task_id: number,
          template_key: body.template_key,
          status: 'completed',
          created_at: new Date().toISOString(),
          result_oss_url: base + '/file.' + (body.template_key.includes('t2v') ? 'mp4' : 'png'),
        })
        if (body.extra_data?.text === '故意丢回执') {
          res.destroy()
          return
        }
        json({ code: 200, data: { task_id: number } })
        return
      }
      if (route === '/rh/alltasks') {
        assert.equal(req.headers['x-auth-token'], 'fixture')
        json({ code: 200, data: { total: records.size, tasks: [...records.values()] } })
        return
      }
      if (route.startsWith('/rh/tasks/')) {
        await delay(90)
        const number = route.split('/').pop()
        const r = records.get(number)
        if (!r) throw Error('missing')
        active--
        json({ code: 200, data: r })
        return
      }
      if (route === '/v1/models') {
        json({ data: [{ id: 'paint' }, { id: 'limited' }] })
        return
      }
      if (route.startsWith('/v1/images/')) {
        const multipart = route.endsWith('edits')
        const n = multipart
          ? Number(raw.toString('latin1').match(/name="n"\r\n\r\n(\d+)/)?.[1] ?? 1)
          : (JSON.parse(raw).n ?? 1)
        pictures.push({ n, mask: raw.includes(Buffer.from('name="mask"')), multipart })
        json({ data: Array.from({ length: n }, () => ({ b64_json: png.toString('base64') })) })
        return
      }
      if (route === '/wan/services/aigc/image-generation/generation') {
        const n = JSON.parse(raw).parameters.n
        wanCounts.push(n)
        json({ output: { task_id: 'wan-native-' + wanCounts.length } })
        return
      }
      if (route.startsWith('/wan/tasks/wan-native-')) {
        const n = Number(route.split('-').at(-1)),
          parts = Array.from({ length: wanCounts[n - 1] }, () => ({ image: base + '/file.png' }))
        json({
          output:
            n === 1
              ? { task_status: 'SUCCEEDED', results: parts.map((v) => ({ url: v.image })) }
              : { task_status: 'SUCCEEDED', choices: [{ message: { content: parts } }] },
        })
        return
      }
      if (route === '/ck/object_info') {
        json({
          CLIPTextEncode: {},
          EmptyLatentImage: {},
          KSampler: {},
          VAEDecode: {},
          SaveImage: { output_node: true },
          CheckpointLoaderSimple: { input: { required: { ckpt_name: [['check.safetensors']] } } },
        })
        return
      }
      if (route === '/ck/prompt') {
        graphs.push(JSON.parse(raw).prompt)
        json({ prompt_id: 'target-' + graphs.length })
        return
      }
      if (route === '/ck/history/target-1') {
        json({ 'target-1': { outputs: { 93: { images: [{ filename: 'ok.png', type: 'output' }] } } } })
        return
      }
      if (route === '/ck/view') {
        res.end(png)
        return
      }
      if (/^\/ck\/history\/target-[3-9]$/.test(route)) {
        const id = route.split('/').pop()
        json({ [id]: { outputs: { 7: { images: [{ filename: 'ok.png', type: 'output' }] } } } })
        return
      }
      if (route === '/ck/history/target-2') {
        json({})
        return
      }
      if (route === '/ck/queue') {
        json({ queue_pending: cancelled ? [] : [[1, 'target-2']], queue_running: [] })
        return
      }
      if (route === '/ck/api/jobs/target-2/cancel') {
        cancelled = true
        json({ cancelled: true })
        return
      }
      throw Error('Unexpected route ' + route)
    } catch (e) {
      res.statusCode = 500
      res.end(String(e))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = 'http://127.0.0.1:' + server.address().port
  const call = (name, args = {}) =>
    page.evaluate(([method, params]) => window.__TAURI_INTERNALS__.invoke(method, params), [name, args])
  const state = () => call('studio_state'),
    job = async (id) => (await state()).jobs.find((j) => j.id === id)
  const wait = async (id, status = 'done') => {
    for (let n = 0; n < 240; n++) {
      const j = await job(id)
      if (j?.status === status) return j
      if (j && ['failed', 'paused', 'uncertain'].includes(j.status) && j.status !== status)
        throw Error(j.status + ' ' + j.detail)
      await delay(90)
    }
    throw Error('Timed out ' + status + ' ' + id)
  }
  const record = (protocol, model, key, base, models = []) =>
    call('edit_profile', { input: { protocol, model, key, base, models, name: model } })
  const scene = (name) => ({
    id: '',
    heading: name,
    action: name,
    dialogue: '台词 ' + name,
    imagePrompt: '图 ' + name,
    videoPrompt: '视频 ' + name,
  })
  const button = (name, context = page) => context.getByRole('button', { name, exact: true })
  try {
    const rh = await record('rh-image', '官网模拟', 'fixture', base + '/rh')
    const videoProfile = await record('rh-video', '官网视频', 'fixture', base + '/rh')
    const open = await record('openai-image', 'paint', 'fixture', base + '/v1', ['limited'])
    const script = await call('create_script', {
      story: { title: '项目验收', scenes: [scene('桥'), scene('灯'), scene('海')] },
    })
    const t = templates.find((t) => t.Key.includes('gpt-image2-t2i')),
      other = templates.find((t) => t.Name.includes('Banana')),
      film = templates.find((t) => t.Key.includes('minimax-h3-t2v'))
    const config = (t) => Object.fromEntries(t.Fields.map((f) => [f.Key, f.Default]))
    const shot = (i) => ({
      scriptId: script.id,
      sceneId: script.scenes[i].id,
      label: script.title + ' · 第 ' + (i + 1) + ' 镜',
    })
    const input = (i, template = t) => ({
      shot: shot(i),
      profileId: template.Video ? videoProfile : rh,
      kind: template.Video ? 'video' : 'image',
      template: template.Key,
      prompt: '第 ' + i + ' 镜',
      size: '1:1',
      seconds: 0,
      config: config(template),
      priority: 0,
      assets: [],
    })
    const create = (inputs) => call('create_batch', { inputs, limit: 1, budget: 1, allowUnknown: false })
    const jobIds = async (id) =>
      (await call('list_batches')).find((b) => b.id === id).jobs.map((j) => j.id)
    const pending = [input(0), input(0, other), input(1), input(1, other)]
    await assert.rejects(() =>
      call('create_batch', { inputs: pending, limit: 1, budget: 0.01, allowUnknown: false })
    )
    const batch = await create(pending),
      ids = await jobIds(batch)
    assert.equal(ids.length, 4)
    assert.equal(calls.length, 0)
    await call('withdraw_job', { id: ids[3] })
    await call('run_batch', { id: batch })
    await Promise.all(ids.slice(0, 3).map((id) => wait(id)))
    assert.equal(calls.length, 3)
    assert.equal(maximum, 1)
    await call('set_final', {
      scriptId: script.id,
      sceneId: shot(0).sceneId,
      kind: 'image',
      jobId: ids[0],
    })
    const lost = await call('start_job', { input: { ...input(1), prompt: '故意丢回执' } })
    await wait(lost, 'uncertain')
    assert.equal(calls.length, 4)
    await assert.rejects(() => call('check_receipt', { id: lost, number: '99999' }))
    await assert.rejects(() => call('attach_receipt', { id: lost, number: '1000' }))
    const receipt = await call('check_receipt', { id: lost, number: '1003' })
    assert.equal(receipt.model, t.Key)
    await call('attach_receipt', { id: lost, number: '1003' })
    await wait(lost)
    assert.equal(calls.length, 4)
    const imagePath = path.join(temp, 'card-original.png')
    await writeFile(imagePath, png)
    const [picked] = await call('add_files', { kind: 'image', paths: [imagePath] })
    await call('save_card', {
      input: { name: '灯塔', category: '场景', description: '远景海岸', items: [picked] },
    })
    const [card] = await call('list_cards')
    assert.equal(card.name, '灯塔')
    const hashPath = await call('asset_preview', { item: card.items[0] })
    await rename(imagePath, imagePath + '.moved')
    assert.deepEqual(await readFile(hashPath), png)
    const put = (i, asset) => {
      const vkey = JSON.stringify([rh, 'image', base + '/rh', t.Key])
      return call('save_shot_draft', {
        draft: {
          kind: 'image',
          shot: shot(i),
          updated: Date.now(),
          editor: {
            service: rh,
            models: {},
            templates: { [rh]: t.Key },
            prompt: '图 ' + script.scenes[i].heading,
            scriptPrompt: '图 ' + script.scenes[i].heading,
            compare: '',
            variants: {
              [vkey]: {
                config: config(t),
                size: '1:1',
                seconds: 0,
                priority: 0,
                byMode: { archived: [asset] },
              },
            },
          },
        },
        picks: [asset],
      })
    }
    await put(0, card.items[0])
    const alternate = path.join(temp, 'second-card.png')
    assert.equal(
      spawnSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=blue:s=8x8',
        '-frames:v',
        '1',
        alternate,
      ]).status,
      0
    )
    const [replacement] = await call('add_files', { kind: 'image', paths: [alternate] })
    await call('save_card', {
      input: {
        id: card.id,
        name: card.name,
        category: card.category,
        description: '晨光',
        items: [replacement],
      },
    })
    const newer = (await call('list_cards')).find((v) => v.id === card.id)
    await put(1, newer.items[0])
    const savedDrafts = await call('list_shot_drafts')
    for (const [i, bytes] of [
      [0, png],
      [1, await readFile(alternate)],
    ]) {
      const d = savedDrafts.find(
        (v) => v.shot.scriptId === script.id && v.shot.sceneId === shot(i).sceneId
      )
      const asset = Object.values(d.editor.variants)[0].byMode.archived[0]
      assert.deepEqual(await readFile(await call('asset_preview', { item: asset })), bytes)
    }
    await call('mark_work', {
      id: ids[0],
      mark: { favorite: true, archived: false, tags: ['夜景', '灯塔'] },
    })
    assert.equal((await call('library_marks'))[ids[0]].favorite, true)
    await call('record_charge', {
      id: ids[0],
      charge: { amount: 0.09, unit: 'CNY', receipt: '模拟账单-1' },
    })
    assert.equal((await call('get_charge', { id: ids[0] })).amount, 0.09)
    await call('discover_models', {
      input: { source: 'connection', base: base + '/v1', id: open, key: '' },
    })
    const caps = { sizes: ['1024x1024'], maxImages: 1, firstLast: false, mask: true, multi: 4 }
    await call('set_model_features', { profileId: open, model: 'paint', features: caps })
    await call('set_model_features', {
      profileId: open,
      model: 'limited',
      features: { ...caps, maxImages: 0, mask: false, multi: 1 },
    })
    const mask = await page.evaluate(async () => {
      const c = document.createElement('canvas')
      c.width = c.height = 1
      const b = await new Promise((r) => c.toBlob(r, 'image/png'))
      return window.__TAURI_INTERNALS__.invoke('save_mask', new Uint8Array(await b.arrayBuffer()))
    })
    const painted = {
      ...input(0),
      profileId: open,
      model: 'paint',
      size: '1024x1024',
      config: { mode: 'i2i' },
      count: 4,
      assets: card.items,
      mask,
      sourceJob: ids[0],
    }
    await assert.rejects(() => call('start_job', { input: { ...painted, model: 'limited' } }))
    const native = await call('start_job', { input: painted })
    const result = await wait(native)
    assert.equal(result.candidateIds.length, 4)
    assert.equal(pictures.length, 1)
    assert.deepEqual(pictures[0], { n: 4, mask: true, multipart: true })
    for (const id of result.candidateIds)
      assert.deepEqual(await readFile((await wait(id)).mediaPath), png)
    await call('choose_candidate', { id: result.candidateIds[2] })
    assert.equal(await call('candidate_choice', { id: native }), result.candidateIds[2])
    const features = await call('get_model_features', { profileId: open, model: 'paint' })
    assert.ok(features.listed && features.tested.some((t) => t.mask && t.results === 4))
    const wan = await record('wan-image', 'wan-fixture', 'fixture', base + '/wan')
    await call('set_model_features', {
      profileId: wan,
      model: 'wan-fixture',
      features: { ...caps, multi: 2, mask: false },
    })
    for (const _ of [1, 2]) {
      const id = await call('start_job', {
        input: {
          ...input(1),
          profileId: wan,
          model: 'wan-fixture',
          count: 2,
          size: '1024x1024',
          config: { mode: 't2i' },
        },
      })
      const j = await wait(id)
      assert.equal(j.candidateIds.length, 2)
      for (const id of j.candidateIds) assert.deepEqual(await readFile((await wait(id)).mediaPath), png)
    }
    assert.deepEqual(wanCounts, [2, 2])
    const fallback = await call('start_job', { input: { ...input(1), repeat: 2 } })
    const pair = (await job(fallback)).candidateIds
    await Promise.all(pair.map((id) => wait(id)))
    assert.equal(calls.length, 6)
    const ck = await record('comfy-image', 'check.safetensors', '', base + '/ck')
    const g = {
      graph: {
        9: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'check.safetensors' } },
        20: { class_type: 'CLIPTextEncode', inputs: { text: '替换前', clip: ['9', 1] } },
        21: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['9', 1] } },
        30: { class_type: 'EmptyLatentImage', inputs: { width: 640, height: 384, batch_size: 1 } },
        50: {
          class_type: 'KSampler',
          inputs: {
            model: ['9', 0],
            seed: 7,
            steps: 10,
            cfg: 5,
            sampler_name: 'euler',
            scheduler: 'normal',
            positive: ['20', 0],
            negative: ['21', 0],
            latent_image: ['30', 0],
            denoise: 1,
          },
        },
        63: { class_type: 'VAEDecode', inputs: { samples: ['50', 0], vae: ['9', 2] } },
        93: { class_type: 'SaveImage', inputs: { images: ['63', 0], filename_prefix: '验收' } },
      },
      promptNode: '20',
      promptField: 'text',
      imageNode: null,
      imageField: 'image',
      outputNode: '93',
    }
    await assert.rejects(() =>
      call('configure_graph', {
        profileId: ck,
        model: 'check.safetensors',
        graph: { ...g, graph: { ...g.graph, 8: { class_type: 'NotInstalled', inputs: {} } } },
      })
    )
    await call('configure_graph', { profileId: ck, model: 'check.safetensors', graph: g })
    const comfy = {
      ...input(1),
      profileId: ck,
      model: 'check.safetensors',
      size: '512x512',
      config: { mode: 't2i' },
      prompt: '新的工作流提示词',
    }
    const ckId = await call('start_job', { input: comfy })
    const customResult = await wait(ckId)
    assert.equal(customResult.size, '640x384')
    assert.equal(customResult.settings.seed, 7)
    assert.equal(graphs[0]['20'].inputs.text, comfy.prompt)
    const ckCancel = await call('start_job', { input: comfy })
    await wait(ckCancel, 'waiting')
    assert.match(await call('cancel_remote', { id: ckCancel }), /受理/)
    await wait(ckCancel, 'cancelled')
    await call('configure_graph', { profileId: ck, model: 'check.safetensors', graph: null })
    const random = await call('start_job', { input: { ...comfy, repeat: 4 } })
    await Promise.all((await job(random)).candidateIds.map((id) => wait(id)))
    assert.equal(new Set(graphs.slice(-4).map((g) => g['5'].inputs.seed)).size, 4)
    const batchMasks = await call('create_batch', {
      inputs: [painted],
      limit: 1,
      budget: null,
      allowUnknown: true,
    })
    const [maskedId] = await jobIds(batchMasks)
    await call('run_batch', { id: batchMasks })
    await wait(maskedId)
    assert.deepEqual(pictures.at(-1), { n: 4, mask: true, multipart: true })
    const gate = await create([input(0), input(1)])
    const gated = await jobIds(gate)
    await call('run_batch', { id: gate })
    const manual = await call('start_job', { input: input(1) })
    await Promise.all([...gated, manual].map((id) => wait(id)))
    assert.equal(maximum, 1)
    const videos = []
    for (let i = 0; i < 3; i++) {
      const id = await call('start_job', { input: input(i, film) })
      await wait(id)
      videos.push(id)
      if (i < 2)
        await call('set_final', {
          scriptId: script.id,
          sceneId: shot(i).sceneId,
          kind: 'video',
          jobId: id,
        })
    }
    await assert.rejects(() => call('deliver_film', { scriptId: script.id, combine: false }), /第 3 镜/)
    await call('set_final', {
      scriptId: script.id,
      sceneId: shot(2).sceneId,
      kind: 'video',
      jobId: videos[2],
    })
    const nextFrame = await call('extract_frame', { id: videos[0], seconds: 0.25 })
    assert.ok(nextFrame.token)
    const edited = await call('edit_script', {
      id: script.id,
      story: { title: script.title, scenes: [...script.scenes].reverse() },
    })
    const dir = await call('deliver_film', { scriptId: script.id, combine: true })
    const lines = (await readFile(path.join(dir, '镜头与台词.tsv'), 'utf8')).trim().split('\n')
    assert.match(lines[1], /001\t海\t台词 海/)
    assert.deepEqual(await readFile(path.join(dir, '001-视频.mp4')), video)
    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(dir, '整片.mp4')],
      { encoding: 'utf8' }
    )
    assert.ok(Number(probe.stdout) > 2.8 && Number(probe.stdout) < 3.3, probe.stdout)
    const archive = await call('export_project', { id: script.id })
    const pre = await call('import_project', { path: archive, commit: false })
    assert.equal(pre.scenes[0], '海')
    assert.equal(pre.conflicts, 1)
    assert.equal(pre.drafts, 2)
    const restored = await call('import_project', { path: archive, commit: true })
    assert.notEqual(restored.id, script.id)
    const orig = await job(ids[0])
    const copy = (await state()).jobs.find(
      (j) => j.shot?.scriptId === restored.id && j.model === orig.model && j.file
    )
    assert.deepEqual(await readFile(copy.mediaPath), png)
    assert.ok((await call('list_shot_drafts')).some((d) => d.shot.scriptId === restored.id))
    const countBefore = calls.length + graphs.length + pictures.length
    await rm(path.join(data, 'tasks', ids[3] + '.json'))
    page = await restart()
    await delay(250)
    assert.equal(calls.length + graphs.length + pictures.length, countBefore)
    assert.equal(await job(ids[3]), undefined)
    await button('剧本').click()
    await page.locator('.script-history').getByText(edited.title, { exact: true }).click()
    await button('整片预览与交付').click()
    const dialog = page.getByRole('dialog', { name: '整片预览与交付' })
    await dialog.getByText(/总时长 3\.00 秒/).waitFor()
    await button('关闭', dialog).click()
    await button('镜头队列与预算').click()
    await page
      .getByRole('dialog', { name: '镜头队列与预算' })
      .getByText(/次提交 · 已知预估/)
      .waitFor()
    await button('关闭', page.getByRole('dialog', { name: '镜头队列与预算' })).click()
    await button('创作台').click()
    await button('图片').click()
    await page.getByLabel('生成服务', { exact: true }).selectOption(open)
    await page.getByLabel('创作方式', { exact: true }).selectOption('i2i')
    await page.locator('#prompt').fill('用界面验证遮罩与候选')
    await button('角色与场景卡').click()
    const cards = page.getByRole('dialog', { name: '角色与场景卡' })
    await cards.getByRole('combobox').first().selectOption(card.id)
    await button('将卡片用于当前镜头', cards).click()
    await button('绘制局部遮罩').click()
    const painter = page.getByRole('dialog', { name: '绘制局部遮罩' })
    await page.waitForFunction(() => document.querySelector('.mask-paint img')?.naturalWidth > 0)
    await painter.locator('canvas').click()
    await button('使用涂选区域', painter).click()
    await button('重画局部遮罩').waitFor()
    await page.getByLabel('生成模型', { exact: true }).selectOption('limited')
    await page.getByText(/参考图超过此模型上限/).waitFor()
    assert.equal(await page.locator('#prompt').inputValue(), '用界面验证遮罩与候选')
    await page.getByLabel('生成模型', { exact: true }).selectOption('paint')
    await page.getByLabel('同模型候选数').selectOption('2')
    await button('生成 2 张候选').click()
    await page.waitForFunction(
      async () =>
        (await window.studio.state()).jobs.filter(
          (j) => j.prompt === '用界面验证遮罩与候选' && j.status === 'done'
        ).length === 2
    )
    assert.deepEqual(pictures.at(-1), { n: 2, mask: true, multipart: true })
    await button('作品库').click()
    await page.getByLabel('搜索作品').fill('用界面验证遮罩与候选')
    await page.locator('.library-page .card').first().dblclick()
    await button('对照 2 张候选').click()
    const gallery = page.getByRole('dialog', { name: '同模型候选' })
    await gallery.getByRole('img').nth(1).waitFor()
    await button('选为定稿', gallery).last().click()
    await button('已定稿', gallery).waitFor()
    console.log(
      'Roadmap acceptance passed: single-POST receipt recovery, budget and cancellation, content snapshots, four native image candidates with mask, two queued candidates, scoped model evidence, imported Comfy graph, remote cancellation, ordered movie and offline project import with zero reposts.'
    )
  } finally {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
}
