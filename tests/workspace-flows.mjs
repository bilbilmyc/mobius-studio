import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'

const brief = '一艘末班渡船穿过晨雾，两名乘客在对岸重逢。'
const scene = { heading: '渡口 · 清晨', action: '渡船在晨雾中靠岸。', dialogue: '我等到你了。',
  imagePrompt: '蓝灰色晨雾中的渡口，船头一盏暖灯', videoPrompt: '跟随渡船缓慢推进，镜头转向岸上的人' }

// Verify the transmitted request against S3's query-signing rules independently of the application.
export function verifyPut(req, url) {
  const query = url.searchParams
  const signature = query.get('X-Amz-Signature')
  query.delete('X-Amz-Signature')
  const [access, date, region, service, suffix] = query.get('X-Amz-Credential').split('/')
  assert.deepEqual([access, region, service, suffix], ['storage-fixture', 'auto', 's3', 'aws4_request'])
  const names = query.get('X-Amz-SignedHeaders')
  assert.equal(names, 'content-type;host')
  const headers = names.split(';').map(name => name + ':' + req.headers[name] + '\n').join('')
  const canonicalQuery = [...query].map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).sort().join('&')
  const request = ['PUT', url.pathname, canonicalQuery, headers, names, 'UNSIGNED-PAYLOAD'].join('\n')
  const digest = createHash('sha256').update(request).digest('hex')
  const message = ['AWS4-HMAC-SHA256', query.get('X-Amz-Date'), [date, region, service, suffix].join('/'), digest].join('\n')
  const key = [date, region, service, suffix].reduce((key, part) =>
    createHmac('sha256', key).update(part).digest(), 'AWS4' + 'storage-fixture-secret')
  assert.equal(signature, createHmac('sha256', key).update(message).digest('hex'))
}

export function workspaceMock(png) {
  const uploads = []
  let scripts = 0, writerLists = 0, ossUploads = 0
  return {
    uploads,
    handle(req, res, bytes) {
      if (req.headers.authorization?.startsWith('OSS4-HMAC-SHA256 ')) {
        assert.equal(req.method, 'PUT')
        assert.deepEqual(bytes, png)
        const dateTime = req.headers['x-oss-date'], date = dateTime.slice(0, 8)
        const scope = date + '/cn-hangzhou/oss/aliyun_v4_request'
        const claims = Object.fromEntries(req.headers.authorization.slice('OSS4-HMAC-SHA256 '.length).split(/,\s*/).map(pair => pair.split('=')))
        assert.equal(claims.Credential, 'oss-fixture/' + scope)
        assert.equal(claims.AdditionalHeaders, 'host')
        assert.equal(req.headers['content-type'], 'image/png')
        assert.equal(req.headers['x-oss-content-sha256'], 'UNSIGNED-PAYLOAD')
        assert.match(decodeURIComponent(req.url), /^\/镜头\/夜 景\/[a-f\d]+\.png$/)
        const headers = ['content-type', 'host', 'x-oss-content-sha256', 'x-oss-date'].map(name => name + ':' + req.headers[name] + '\n').join('')
        const canonical = ['PUT', '/photos' + req.url, '', headers, 'host', 'UNSIGNED-PAYLOAD'].join('\n')
        const signingKey = [date, 'cn-hangzhou', 'oss', 'aliyun_v4_request'].reduce((key, part) =>
          createHmac('sha256', key).update(part).digest(), 'aliyun_v4oss-fixture-secret')
        const toSign = ['OSS4-HMAC-SHA256', dateTime, scope, createHash('sha256').update(canonical).digest('hex')].join('\n')
        assert.equal(claims.Signature, createHmac('sha256', signingKey).update(toSign).digest('hex'))
        ossUploads++
        res.end()
        return true
      }
      if (req.url === '/v1/models' && req.headers.authorization === 'Bearer writer-ui-fixture') {
        assert.equal(req.method, 'GET')
        writerLists++
        res.end(JSON.stringify({ data: [{ id: 'studio-writer-from-list' }, { id: 'deepseek-v4-pro' }, { id: 'studio-writer-from-list' }] }))
        return true
      }
      if (req.url === '/v1/chat/completions') {
        assert.equal(req.method, 'POST')
        assert.equal(req.headers.authorization, 'Bearer writer-ui-fixture')
        const body = JSON.parse(bytes)
        assert.equal(body.model, 'studio-writer-from-list')
        assert.equal(body.response_format.type, 'json_object')
        assert.ok(body.messages[1].content.includes(brief))
        const content = JSON.stringify({ title: '晨渡', scenes: [scene, { ...scene, heading: '对岸 · 日出' }] })
        res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }))
        scripts++
        return true
      }
      if (req.url.startsWith('/store/')) {
        assert.equal(req.method, 'PUT')
        const url = new URL(req.url, 'http://' + req.headers.host)
        assert.equal(req.headers['content-type'], 'image/png')
        assert.deepEqual(bytes, png)
        assert.equal(req.headers.authorization, undefined)
        verifyPut(req, url)
        uploads.push(decodeURIComponent(url.pathname))
        res.writeHead(uploads.length === 1 ? 403 : 200)
        res.end()
        return true
      }
      return false
    },
    check() {
      assert.equal(scripts, 1)
      assert.equal(writerLists, 2)
      assert.equal(ossUploads, 1)
      assert.equal(uploads.length, 3)
      assert.equal(uploads[0], uploads[1])
      assert.notEqual(uploads[0], uploads[2])
    },
  }
}

export async function exerciseWorkspace({ page, base, oldId, shot, state, mock }) {
  const button = name => page.getByRole('button', { name, exact: true })
  await button('剧本').click()
  await page.getByLabel('故事构想').fill(brief)
  await page.getByLabel('分镜数量').selectOption('2')
  await button('配置剧本模型').click()
  // Hold the previous directory response until the new connection has returned its list.
  const previous = new URL('/previous-service', base).href
  await page.evaluate(url => {
    const real = window.studio.discoverModels
    window.studio.discoverModels = query => {
      if (query.base !== url) return real(query)
      window.studio.discoverModels = real
      return new Promise(resolve => {
        window.finishPreviousCatalog = () => resolve({ base: url, models: ['stale-model'] })
      })
    }
  }, previous)
  await page.getByLabel('剧本服务地址').fill(previous)
  await page.getByLabel('剧本 API Key').fill('previous-fixture')
  await button('获取模型列表').click()
  await button('正在获取…').waitFor()
  await page.getByLabel('剧本服务地址').fill(new URL(base).origin)
  assert.equal(await page.getByLabel('剧本 API Key').inputValue(), '')
  await page.getByLabel('剧本 API Key').fill('writer-ui-fixture')
  await button('获取模型列表').click()
  const listed = page.getByRole('combobox', { name: '从服务商选择模型' })
  await listed.selectOption('studio-writer-from-list')
  await page.evaluate(async () => {
    window.finishPreviousCatalog()
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  assert.equal(await listed.inputValue(), 'studio-writer-from-list')
  assert.equal(await listed.locator('option').count(), 2)
  await shot('剧本模型列表')
  await button('保存剧本模型').click()
  await page.getByText('设置已保存。', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('剧本服务地址').inputValue(), base)
  assert.equal(await page.getByLabel('剧本 API Key').inputValue(), '')
  await button('获取模型列表').click()
  await listed.waitFor()
  assert.equal(await listed.inputValue(), 'studio-writer-from-list')
  await button('剧本').click()
  assert.equal(await page.getByLabel('故事构想').inputValue(), brief)
  await button('生成剧本').click()
  await page.getByRole('heading', { name: '晨渡' }).waitFor()
  assert.equal(await page.locator('.shot-list li').count(), 2)
  await button('编辑剧本').click()
  await page.getByLabel('剧本标题').fill('渡口，日出之前')
  await button('保存剧本').click()
  await page.getByRole('heading', { name: '渡口，日出之前' }).waitFor()
  await shot('script')
  await button('用于视频').first().click()
  assert.equal(await page.locator('#prompt').inputValue(), scene.videoPrompt)
  await button('剧本').click()
  await button('用于生图').first().click()
  assert.equal(await page.locator('#prompt').inputValue(), scene.imagePrompt)
  await button('设置').click()
  await button('对象存储').click()
  const providers = page.getByLabel('存储服务商')
  assert.deepEqual(await providers.locator('option').evaluateAll(options => options.map(o => o.value)), ['aliyun', 'tencent', 'volcengine', 'aws', 's3'])
  assert.equal(await providers.inputValue(), 'aliyun')
  await shot('对象存储服务商')
  await providers.selectOption('tencent')
  await page.getByLabel('存储桶名称（含 APPID）').fill('photos')
  await page.getByLabel('SecretId').fill('test')
  await page.getByLabel('SecretKey').fill('temporary-fixture')
  await button('保存对象存储').click()
  await page.getByText(/腾讯云 COS 需要带 APPID/).waitFor()
  await providers.selectOption('volcengine')
  assert.equal(await page.getByLabel('Secret Access Key').inputValue(), '')
  await page.getByText('https://tos-s3-cn-beijing.volces.com').waitFor()
  await providers.selectOption('aws')
  await page.getByLabel('存储桶地域').fill('cn-northwest-1')
  await page.getByText('https://s3.cn-northwest-1.amazonaws.com.cn').waitFor()
  await providers.selectOption('aliyun')
  await page.getByLabel('自定义域名').fill(new URL(base).origin)
  await page.getByLabel('Bucket', { exact: true }).fill('photos')
  await page.getByLabel('对象前缀').fill('镜头/夜 景')
  await page.getByLabel('Access Key ID', { exact: true }).fill('oss-fixture')
  await page.getByLabel('Secret Access Key').fill('oss-fixture-secret')
  await button('保存对象存储').click()
  await page.getByText('设置已保存。', { exact: true }).waitFor()
  await button('作品库').click()
  await page.getByLabel('筛选作品').selectOption('image')
  await page.locator('.card').filter({ hasText: '旧版测试作品' }).click()
  await button('存到对象存储').click()
  await page.getByText('已上传 · oss://photos/镜头/夜 景/' + oldId + '.png').waitFor()
  await button('设置').click()
  await button('对象存储').click()
  await providers.selectOption('s3')
  assert.equal(await page.getByLabel('Access Key ID', { exact: true }).inputValue(), '')
  await page.getByLabel('Endpoint', { exact: true }).fill(new URL('/store', base).href)
  await page.getByLabel('Bucket', { exact: true }).fill('pictures')
  await page.getByLabel('签名区域').fill('auto')
  await page.getByLabel('对象前缀').fill('镜头/夜 景')
  await page.getByLabel('Access Key ID', { exact: true }).fill('storage-fixture')
  await page.getByLabel('Secret Access Key').fill('storage-fixture-secret')
  assert.equal(await page.getByLabel('生成图片后自动上传').isChecked(), false)
  await page.getByLabel('生成图片后自动上传').check()
  await button('保存对象存储').click()
  await page.getByText('设置已保存。', { exact: true }).waitFor()
  await shot('settings-storage')
  await button('作品库').click()
  await page.getByLabel('筛选作品').selectOption('image')
  await page.locator('.card').filter({ hasText: '旧版测试作品' }).click()
  await button('存到对象存储').click()
  await button('重试上传').waitFor()
  assert.equal((await state()).jobs.find(j => j.id === oldId).status, 'done')
  await button('重试上传').click()
  await page.getByText('已上传 · s3://pictures/镜头/夜 景/' + oldId + '.png').waitFor()
  await button('创作台').click()
  const provider = (await state()).profiles.find(p => p.Name === '测试图片')
  await page.getByLabel('生成服务').selectOption(provider.Id)
  await page.getByLabel('生成模型', { exact: true }).selectOption('local-image')
  await page.getByLabel('创作方式').selectOption('t2i')
  await button('生成图片').click()
  await page.getByRole('group', { name: '最近提交的任务' }).filter({ hasText: scene.imagePrompt }).getByRole('button').click()
  await page.locator('.detail .cloud-location').waitFor()
  const saved = (await state()).jobs.find(j => j.prompt === scene.imagePrompt)
  assert.ok(saved.file && saved.cloud.status === 'saved')
  const script = await page.evaluate(async ()=>(await window.studio.scripts())[0])
  assert.equal(saved.shot.scriptId,script.id);assert.equal(saved.shot.sceneId,script.scenes[0].id)
  await button('剧本').click();await page.getByText(/^关联作品 · /).first().click()
  await button('设为定稿').click();await button('已定稿').waitFor()
  await shot('分镜关联作品')
  await button('用定稿图生视频').click()
  await page.getByRole('img',{name:'视频首帧预览'}).waitFor()
  assert.equal(await page.locator('#prompt').inputValue(),scene.videoPrompt)
  await page.getByText('渡口，日出之前 · 第 1 镜',{exact:true}).waitFor()
  assert.equal(mock.uploads.at(-1), '/store/pictures/镜头/夜 景/' + saved.id + '.png')
  mock.check()
}
