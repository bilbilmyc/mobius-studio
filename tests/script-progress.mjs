import assert from 'node:assert/strict'
import { waitForValue } from './wait-for-value.mjs'

export function scriptProgressFixture() {
  const requests = new Map()
  return {
    requests,
    handle(req, res, bytes) {
      assert.equal(req.url, '/v1/chat/completions')
      const body = JSON.parse(bytes)
      const [, count, brief] = /^请写 (\d+) 个分镜。\n\n([\s\S]+)$/.exec(body.messages[1].content)
      assert.ok(!requests.has(brief), 'A script was submitted twice')
      requests.set(brief, { model: body.model, auth: req.headers.authorization, finish(title, status = 200) {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        const scenes = Array.from({ length: Number(count) }, (_, i) => ({
          heading: '镜头 ' + (i + 1), action: brief, dialogue: '明天见。', imagePrompt: brief, videoPrompt: brief,
        }))
        res.end(JSON.stringify(status === 200 ? { choices: [{ message: { content: JSON.stringify({ title, scenes }) } }] }
          : { error: { message: 'upstream unavailable' } }))
      } })
    },
  }
}

export async function exerciseScriptProgress({ page, base, fixture, shot, restart }) {
  const button = name => page.getByRole('button', { name, exact: true })
  const heading = name => page.getByRole('heading', { name, exact: true })
  const idea = () => page.getByRole('textbox', { name: '故事构想', exact: true })
  const count = () => page.getByLabel('分镜数量')
  const taskDialog = () => page.getByRole('dialog', { name: '后台任务' })
  const active = n => page.waitForFunction(n => document.querySelector('#task-count')?.textContent === String(n), n)
  const received = brief => waitForValue(() => fixture.requests.get(brief), 'writer request')
  const first = '末班渡轮即将离岸，年轻的灯塔守夜人收到一封迟了二十年的来信。她必须在天亮前找到寄信人。'
  const second = '暴雨过后，小镇唯一的钟表匠在停摆的钟楼里听见了第二个心跳。'
  const third = '屋顶上的旧收音机突然响起。'
  const fourth = '窗外驶过最后一班列车。'
  await page.evaluate(async base => {
    await window.studio.saveWriter({ id:'@new', name:'潮汐工作室', base, model:'writer-first', key:'fixture-one', activate:true })
    await window.studio.saveWriter({ id:'@new', name:'夜航工作室', base, model:'writer-second', key:'fixture-two', activate:false })
  }, base)
  await page.reload()
  await button('剧本').click()
  await idea().fill(first)
  await count().selectOption('6')
  await button('生成剧本').dblclick()
  await heading('正在生成剧本').waitFor()
  await active(1)
  const firstPost = await received(first)
  assert.equal(firstPost.auth, 'Bearer fixture-one')
  const view = page.getByRole('region', { name:'正在生成剧本' })
  await view.getByText(first, { exact: true }).waitFor()
  await view.getByText('6 个分镜', { exact: true }).waitFor()
  await page.emulateMedia({ reducedMotion:'no-preference' })
  const film = page.locator('.script-film-belt')
  const pose = await film.evaluate(el => getComputedStyle(el).transform)
  await page.waitForFunction(before => getComputedStyle(document.querySelector('.script-film-belt')).transform !== before, pose)
  await page.emulateMedia({ reducedMotion:'reduce' })
  assert.equal(await film.evaluate(el => getComputedStyle(el).animationName), 'none')
  await page.emulateMedia({ reducedMotion:'no-preference' })
  for (const mode of ['eco', 'auto']) {
    await button('设置').click()
    await button('性能').click()
    await page.getByLabel('性能模式').selectOption(mode)
    await page.waitForFunction(mode => document.querySelector('.shell').dataset.performance === mode, mode)
    await button('剧本').click()
    assert.equal(await film.evaluate(el => getComputedStyle(el).animationName === 'none'), mode === 'eco')
    await view.getByRole('timer').waitFor()
  }
  for (const [width, height] of [[1440, 900], [320, 420], [768, 640], [2560, 1390]]) {
    await page.setViewportSize({ width, height })
    assert.ok(await view.evaluate(el => el.clientWidth > 0 && el.scrollWidth <= el.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1))
    await button('转入后台').scrollIntoViewIfNeeded()
    if (width === 1440 || width === 320) await shot('剧本前台生成-' + width)
  }
  await page.setViewportSize({ width:1190, height:772 })
  await button('转入后台').click()
  await active(1)
  assert.equal(await idea().inputValue(), '')
  await idea().fill(second)
  await count().selectOption('2')
  const writers = await page.evaluate(async () => (await window.studio.settings()).writers)
  const other = writers.find(w => w.model === 'writer-second')
  await page.getByLabel('剧本服务与模型').selectOption(JSON.stringify([other.id, other.model]))
  await button('生成剧本').click()
  await heading('正在生成剧本').waitFor()
  const secondPost = await received(second)
  assert.equal(secondPost.auth, 'Bearer fixture-two')
  assert.equal(secondPost.model, other.model)
  await active(2)
  await view.getByText(second, { exact:true }).waitFor()
  await button('后台任务').click()
  await taskDialog().getByRole('button', { name:'进行中 2', pressed:true }).waitFor()
  assert.equal(await taskDialog().getByRole('listitem').count(), 2)
  await shot('两份剧本后台任务', taskDialog())
  await taskDialog().getByRole('listitem').filter({hasText:first}).getByRole('button', {name:'查看进度'}).click()
  secondPost.finish('钟楼心跳')
  await active(1)
  await view.getByText(first, { exact:true }).waitFor()
  await idea().fill(third)
  await button('转入后台').click()
  assert.equal(await idea().inputValue(), third)
  firstPost.finish('海上的来信')
  await active(0)
  assert.equal(await idea().inputValue(), third)
  assert.equal(await heading('钟楼心跳').count(), 0, 'a background completion must not replace the next draft')
  await button('后台任务').click()
  await taskDialog().getByRole('button', { name:'已完成 2' }).click()
  await taskDialog().getByRole('listitem').filter({ hasText:'海上的来信' }).getByRole('button', { name:'查看剧本' }).click()
  await heading('海上的来信').waitFor()
  assert.equal(await page.locator('.shot-list > li').count(), 6)
  await button('生成剧本').click()
  const rejected = await received(third)
  rejected.finish('', 503)
  await heading('剧本生成失败').waitFor()
  await page.getByRole('alert').getByText('服务商暂时不可用').waitFor()
  await button('取回构想').click()
  assert.equal(await idea().inputValue(), third)
  await idea().fill(fourth)
  await button('生成剧本').click()
  await received(fourth)
  await page.reload()
  await active(1)
  await button('后台任务').click()
  await taskDialog().getByRole('listitem').filter({ hasText:fourth }).getByRole('button', { name:'查看进度' }).click()
  await heading('正在生成剧本').waitFor()
  page = await restart()
  await active(0)
  await button('后台任务').click()
  await taskDialog().getByRole('listitem').filter({ hasText:fourth }).getByText('已中断', {exact:true}).waitFor()
  const saved = await page.evaluate(() => window.studio.scripts())
  assert.deepEqual(saved.map(s => s.title).sort(), ['海上的来信', '钟楼心跳'].sort())
  assert.equal(fixture.requests.size, 4)
  console.log('Native script foreground, motion, narrow layout, parallel writers, out-of-order completion, draft, error, WebView reload and interrupted restart passed.')
}
