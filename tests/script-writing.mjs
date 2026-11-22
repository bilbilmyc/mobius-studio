import assert from 'node:assert/strict'

export async function exerciseScriptWriting({ page, shot }) {
  const button = (scope, name) => scope.getByRole('button', { name, exact: true })
  const textbox = (scope, name) => scope.getByRole('textbox', { name, exact: true })
  async function expand(label, scope = page) {
    const field = textbox(scope, label)
    await field.locator('..').getByRole('button', { name: /展开编辑/ }).click()
    const dialog = page.getByRole('dialog', { name: '编辑' + label, exact: true })
    const full = textbox(dialog, '完整' + label)
    await full.waitFor()
    assert.ok(await full.evaluate(el => document.activeElement === el), label + ' should receive keyboard focus')
    return { dialog, full }
  }
  const originalSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  await page.setViewportSize({ width: 1440, height: 900 })
  await button(page, '剧本').click()
  const baseline = await page.evaluate(async () => (await window.studio.scripts()).length)
  const idea = textbox(page, '故事构想')
  const passages = [
    '最后一班渡船离岸时，阿禾收到一封迟了二十年的信。寄信人是父亲，收信地址却是明早就要拆除的旧灯塔。',
    '她在靠窗的座位坐下。玻璃上还留着雨痕，对岸的灯隔几秒才亮一次。信封没有封口，里面装着两张船票和一页只写了一半的航行日志。',
    '穿过客舱时，老船长叫住她。他认得日志上的笔迹，也记得那天的雾。阿禾把另一张票放在桌面，两个人都没有先开口。',
    '镜头停在阿禾的手上。她用拇指抚平票角，终于念出日志的最后一句。机器的轰鸣盖住了人声，船头慢慢向灯塔转去。',
    '天亮之前，灯塔的光扫过甲板。阿禾抬头看见岸边站着一个人，手里提着与信封邮戳相同图案的旧提灯。',
  ]
  const opening = '《退潮前的来信》\n\n' + passages.join('\n\n')
  const long = opening + '\n\n' + Array.from({ length: 24 }, () => passages.join('\n\n')).join('\n\n') + '\n终场 🎬'
  await idea.fill(opening)
  await idea.evaluate(el => el.setSelectionRange(2, 6, 'backward'))
  const briefLimit = await idea.getAttribute('maxlength')
  const { dialog, full } = await expand('故事构想')
  assert.deepEqual(await full.evaluate(el => [el.selectionStart, el.selectionEnd, el.selectionDirection]), [2, 6, 'backward'])
  assert.equal(await full.getAttribute('maxlength'), briefLimit)
  await full.fill(long)
  await full.evaluate(el => { el.setSelectionRange(0, 0); el.scrollTop = 0 })
  await shot('剧本-故事构想展开编辑', dialog)
  for (const [width, height] of [[1440, 900], [760, 540], [320, 420]]) {
    await page.setViewportSize({ width, height })
    const fits = await dialog.evaluate(el => {
      const frame = el.getBoundingClientRect()
      const input = el.querySelector('textarea')
      const footer = el.querySelector('footer').getBoundingClientRect()
      return frame.left >= 0 && frame.right <= innerWidth + 1 && frame.top >= 0 && frame.bottom <= innerHeight + 1
        && footer.bottom <= frame.bottom && input.clientHeight >= innerHeight * 0.4
        && input.scrollHeight > input.clientHeight && el.scrollWidth <= el.clientWidth + 1
    })
    assert.ok(fits, 'Long writing area and actions fit at ' + width + '×' + height)
  }
  await full.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true })
  assert.ok(await full.isVisible(), 'IME confirmation keeps the editor open')
  await full.evaluate(el => el.setSelectionRange(24, 30))
  await full.press('Control+Enter')
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForFunction(id => document.activeElement?.id === id, await idea.getAttribute('id'))
  assert.equal(await idea.inputValue(), long)
  assert.deepEqual(await idea.evaluate(el => [el.selectionStart, el.selectionEnd]), [24, 30])
  await page.setViewportSize({ width: 1440, height: 900 })
  await expand('故事构想')
  await full.fill('未采用的结局')
  await button(dialog, '关闭').click()
  assert.equal(await idea.inputValue(), long)
  await button(page, '创作台').click()
  await button(page, '剧本').click()
  assert.equal(await idea.inputValue(), long)

  await button(page, '手写或粘贴分镜').click()
  const manual = page.getByRole('dialog', { name: '手工分镜', exact: true })
  const title = '退潮前的来信 · 手写稿'
  await textbox(manual, '剧本标题').fill(title)
  const sceneOne = ['镜头 1 末班渡船', '画面：' + passages[0], passages[1]]
  const sceneTwo = ['镜头 2 旧灯塔', '画面：' + passages[4]]
  const source = [...sceneOne, '台词：这张票，是留给谁的？', '', ...sceneTwo, '台词：留给想回家的人。'].join('\n')
  const paste = textbox(manual, '分镜正文')
  await paste.fill(source)
  const pasted = await expand('分镜正文', manual)
  assert.equal(await pasted.full.getAttribute('maxlength'), null)
  await pasted.full.fill('暂时删去的镜头')
  await pasted.full.press('Escape')
  assert.equal(await paste.inputValue(), source, 'Escape returns to the open manual form with the original text')
  await expand('分镜正文', manual)
  await pasted.full.evaluate(el => { el.setSelectionRange(0, 0); el.scrollTop = 0 })
  await shot('剧本-手写分镜正文', pasted.dialog)
  const manuscript = [...sceneOne, '台词：' + long, '', ...sceneTwo, '台词：' + long].join('\n')
  assert.ok(manuscript.length > Number(briefLimit))
  await pasted.full.fill(manuscript)
  await button(pasted.dialog, '完成').click()
  assert.equal(await paste.inputValue(), manuscript)
  await button(manual, '拆分并预览').click()
  const scenes = manual.locator('fieldset')
  assert.equal(await scenes.count(), 2)
  const last = scenes.nth(1)
  assert.ok((await textbox(last, '台词或旁白').inputValue()).endsWith('终场 🎬'))
  for (const label of ['画面与动作', '台词或旁白', '图片提示词', '视频提示词']) {
    const field = textbox(last, label)
    const before = await field.inputValue()
    const edit = await expand(label, last)
    assert.equal(await edit.full.inputValue(), before)
    await edit.full.fill(label === '台词或旁白' ? long : '本次取消')
    await button(edit.dialog, label === '台词或旁白' ? '完成' : '取消').click()
    assert.equal(await field.inputValue(), label === '台词或旁白' ? long : before)
  }
  assert.equal(await page.evaluate(async () => (await window.studio.scripts()).length), baseline)
  await button(manual, '保存剧本').click()
  await page.getByRole('heading', { name: title, exact: true }).waitFor()
  const saved = await page.evaluate(async title => (await window.studio.scripts()).find(s => s.title === title), title)
  assert.equal(saved.scenes[0].action, passages.slice(0, 2).join('\n'))
  assert.equal(saved.scenes[1].dialogue, long)
  await page.setViewportSize(originalSize)
  console.log('Script writing passed: ' + long.length + ' characters, selection and focus, three window sizes, nested dialogs and a saved manual script.')
}
