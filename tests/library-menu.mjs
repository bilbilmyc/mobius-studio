import assert from 'node:assert/strict'

export async function exerciseImageMenu(page) {
  const card = page.locator('.card').filter({ hasText: '旧版测试作品' })
  const menu = page.getByRole('menu', { name: '图片作品操作' })
  // Observe the requested operation without modifying the system clipboard or opening a file picker.
  await page.evaluate(() => {
    const { copyImage, exportFile } = window.studio
    window.menuCalls = []
    window.studio.copyImage = async (...args) => { window.menuCalls.push(['copy', ...args]) }
    window.studio.exportFile = async (...args) => { window.menuCalls.push(['save', ...args]); return '' }
    window.restoreMenuCommands = () => Object.assign(window.studio, { copyImage, exportFile })
  })
  try {
    for (const name of ['复制本地图片链接', '复制图像', '另存原文件', '查看作品', '图生视频']) {
      await card.locator('.thumb').click({ button: 'right' })
      const item = menu.getByRole('menuitem', { name, exact: true })
      await item.waitFor({ timeout: 2500 })
      const box = await item.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      // WebView can clear focus between a native mouse press and release.
      await page.evaluate(() => document.activeElement?.blur())
      await page.mouse.up()
      await menu.waitFor({ state: 'detached', timeout: 2500 })
      if (name === '查看作品' || name === '图生视频') {
        const preview = name === '查看作品' ? '作品预览' : '视频首帧预览'
        await page.getByRole('img', { name: preview }).waitFor({ timeout: 2500 })
        await page.getByRole('button', { name: '作品库', exact: true }).click()
      }
    }
    const id = 'a'.repeat(32)
    assert.deepEqual(await page.evaluate(() => window.menuCalls), [
      ['copy', id, true], ['copy', id, false], ['save', id, null, true],
    ])
  } finally { await page.evaluate(() => window.restoreMenuCommands()) }
}

export async function exerciseVideoMenu(page, id) {
  const card = page.locator('.card').filter({ hasText: '测试视频作品' })
  const menu = page.getByRole('menu', { name: '视频作品操作' })
  await card.click({ button: 'right' })
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['查看作品', '另存原文件'])
  await page.evaluate(() => {
    const original = window.studio.exportFile
    window.studio.exportFile = async (...args) => {
      window.videoSave = args
      return ''
    }
    window.restoreVideoSave = () => { window.studio.exportFile = original }
  })
  try {
    await menu.getByRole('menuitem', { name: '另存原文件' }).click()
    assert.deepEqual(await page.evaluate(() => window.videoSave), [id, null, true])
  } finally { await page.evaluate(() => window.restoreVideoSave()) }
  await card.press('Shift+F10')
  await menu.getByRole('menuitem', {name: '查看作品'}).press('Escape')
  assert.equal(await card.evaluate(el => el === document.activeElement), true)
  await card.press('Shift+F10')
  await menu.getByRole('menuitem', { name: '查看作品' }).press('Enter')
  await page.locator('.canvas video').waitFor()
  await page.locator('.detail-heading').getByText('测试视频作品', { exact: true }).waitFor()
}
