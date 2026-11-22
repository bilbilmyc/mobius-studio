import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

// Only explicitly opted-in runs use the paid official service.
export async function exerciseLiveMedia({ page, data, templates, profilesFile, output }) {
  const site = 'https://queueapi.vylai.com/openapi'
  const profiles = JSON.parse((await readFile(profilesFile, 'utf8')).replace(/^\uFEFF/, ''))
  const profile = profiles.find(
    (p) => p.BaseUrl === site && ['rh-image', 'rh-video'].includes(p.ProtocolId) && p.Keys?.[site]
  )
  assert.ok(profile, 'Saved official credential unavailable')
  const image = templates.find((t) => t.Key === 'rh-gpt-image2-t2i-20261009')
  const video = templates.find((t) => t.Key === 'rh-minimax-h3-ref-20261009')
  const configs = [
    { resolution: '1k', aspect: '1:1' },
    { resolution: '480p', aspect: '1:1', mode: 'reference', duration: 5 },
  ]
  function estimate(t, config) {
    return (
      t.Fields.reduce(
        (cost, field) => cost * (field.Options?.find((o) => o.Value === config[field.Key])?.Factor ?? 1),
        t.Rate
      ) * (t.PerSecond ? config.duration : 1)
    )
  }
  const estimatedCny = estimate(image, configs[0]) + estimate(video, configs[1])
  assert.ok(
    estimatedCny > 0 && estimatedCny <= 0.200001,
    'Official catalog quote exceeds this smoke test budget'
  )
  await mkdir(output)
  const receipt = { estimatedCny, items: [] }
  const writeReceipt = () =>
    writeFile(path.join(output, '回归记录.json'), JSON.stringify(receipt, null, 2))
  await writeFile(
    path.join(data, 'connections.json'),
    JSON.stringify([
      {
        Id: profile.Id,
        Name: '官网回归',
        BaseUrl: site,
        ProtocolId: profile.ProtocolId,
        Model: profile.Model,
        Keys: { [site]: profile.Keys[site] },
      },
    ])
  )
  await page.reload()
  await page.locator('#prompt').waitFor()
  assert.equal(await page.evaluate(async () => (await window.studio.state()).official.hasKey), true)
  async function generate(kind, template, config, prompt, assets) {
    const item = { kind, status: 'submitting' }
    receipt.items.push(item)
    await writeReceipt()
    item.id = await page.evaluate((input) => window.studio.start(input), {
      kind,
      profileId: '@site',
      template: template.Key,
      model: null,
      prompt,
      size: '1:1',
      seconds: kind === 'video' ? 5 : 0,
      config,
      priority: 0,
      assets,
    })
    await writeReceipt()
    const until = Date.now() + 18 * 60 * 1000
    while (Date.now() < until) {
      const job = await page.evaluate(
        async (id) => (await window.studio.state()).jobs.find((j) => j.id === id),
        item.id
      )
      assert.ok(job)
      if (item.status !== job.status || item.remoteId !== job.remoteId) {
        item.status = job.status
        item.remoteId = job.remoteId
        await writeReceipt()
      }
      if (job.status === 'done') {
        const file = path.join(
          output,
          (kind === 'image' ? '回归样图' : '回归样片') + path.extname(job.mediaPath)
        )
        await copyFile(job.mediaPath, file)
        const probe = spawnSync(
          'ffprobe',
          [
            '-v',
            'error',
            '-show_entries',
            'stream=codec_type,codec_name,width,height:format=duration',
            '-of',
            'json',
            file,
          ],
          { encoding: 'utf8' }
        )
        assert.equal(probe.status, 0)
        const info = JSON.parse(probe.stdout)
        const picture = info.streams.find((s) => s.codec_type === 'video')
        assert.ok(picture.width > 0 && picture.height > 0)
        item.file = path.basename(file)
        item.media = info
        await writeReceipt()
        if (kind === 'video') assert.ok(Math.abs(Number(info.format.duration) - 5) < 0.8)
        console.log(
          'Official ' +
            kind +
            ' saved: ' +
            picture.width +
            'x' +
            picture.height +
            (kind === 'video' ? ' duration ' + info.format.duration : '')
        )
        return item.id
      }
      if (['failed', 'uncertain', 'paused', 'cancelled', 'withdrawn'].includes(job.status))
        throw Error('Paid test stopped at ' + job.status + '; see the saved receipt before retrying.')
      await delay(4000)
    }
    throw Error('Official service is still processing; receipt retained for recovery.')
  }
  const id = await generate(
    'image',
    image,
    configs[0],
    '方形静物摄影，一只小巧的青瓷茶杯放在浅灰色石台上，晨光从左侧照亮杯沿。简洁背景，没有文字。',
    []
  )
  const pick = await page.evaluate((id) => window.studio.frame(id), id)
  await generate(
    'video',
    video,
    configs[1],
    '以参考图中的青瓷茶杯为主体，杯身保持原样。镜头在五秒内非常缓慢地推近杯沿，最后停稳。',
    [pick]
  )
  console.log('Two paid jobs finished. Catalog estimate CNY ' + estimatedCny.toFixed(2))
}
