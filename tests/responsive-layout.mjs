import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

const sizes = [
  [320, 420], [320, 568], [480, 640], [540, 640], [541, 640], [620, 600], [700, 540], [701, 540],
  [760, 540], [768, 640], [960, 640], [1024, 768], [1190, 772], [1440, 900], [1920, 1080],
  [2560, 1440], [1093, 614, 1.25], [1280, 720, 1.5], [960, 540, 2],
]

export async function exerciseResponsiveLayout({ page, shot }) {
  const button = name => page.getByRole('button', { name, exact: true })
  const cdp = await page.context().newCDPSession(page)
  // Capture through the session that owns device emulation. Playwright's usual screenshot
  // restores its own viewport when a native WebView is attached over a second CDP session.
  const surface = { async screenshot({path}) {
    const {data} = await cdp.send('Page.captureScreenshot', { format:'png', fromSurface:true, captureBeyondViewport:false })
    await writeFile(path, Buffer.from(data, 'base64'))
  } }
  const issues = []
  async function inspect(name, selector, capture = false) {
    for (const [width, height, scale = 1] of sizes) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false })
      const problems = await page.evaluate(({ selector, width, scale }) => {
        const root = document.querySelector(selector)
        const top = document.querySelector('.top h1')
        const overflow = el => el.scrollWidth > el.clientWidth + 2
        const faults = []
        if (innerWidth !== width || Math.abs(devicePixelRatio - scale) > 0.01) faults.push('viewport reports ' + innerWidth + '@' + devicePixelRatio)
        if (overflow(document.documentElement)) faults.push('window scrolls sideways')
        if (top.offsetHeight > parseFloat(getComputedStyle(top).lineHeight) * 1.6) faults.push('page title breaks')
        if (!root || !root.clientWidth) return [...faults, 'missing surface']
        if (root.matches('.work, .script-desk')) {
          const main = root.closest('main')
          const frame = main.getBoundingClientRect()
          const style = getComputedStyle(main)
          const left = frame.left + parseFloat(style.paddingLeft)
          const right = frame.right - parseFloat(style.paddingRight)
          for (const el of [top.parentElement, root, main.querySelector('.status')]) {
            const box = el.getBoundingClientRect()
            if (Math.abs(box.left - left) > 1 || Math.abs(box.right - right) > 1) faults.push(el.className + ' is inset from the workspace')
          }
          if (root.matches('.script-desk') && width > 620) {
            const sidebar = root.querySelector('.writing-sidebar').getBoundingClientRect()
            const manuscript = root.querySelector('.manuscript').getBoundingClientRect()
            const desk = root.getBoundingClientRect()
            if (Math.abs(sidebar.left - left) > 1 || (width >= 1440 && Math.abs(sidebar.width - 360) > 1)) faults.push('script sidebar moved or changed width')
            if (Math.abs(sidebar.top - desk.top) > 1 || Math.abs(sidebar.bottom - desk.bottom) > 1) faults.push('script sidebar does not fill the workspace height')
            const scrollbar = root.offsetWidth - root.clientWidth
            if (Math.abs(manuscript.right - (right - scrollbar)) > 1) faults.push('manuscript does not fill the available width')
          }
        }
        const areas = [root, ...root.querySelectorAll('.settings-scroll,.dialog-body,.preferences-content,.library-filters,.task-row,.writing-form,.label-row,.modal-actions,.library-pages,.saved-connection,.connection-models,.preference-row')]
        for (const el of areas) if (el.clientWidth && overflow(el)) faults.push(el.className || el.tagName)
        for (const el of root.querySelectorAll('.library-pages button')) {
          const text = document.createRange()
          text.selectNodeContents(el)
          if (text.getClientRects().length > 1) faults.push('page button label wraps')
        }
        if (root.matches('.work')) {
          const preview = root.querySelector('.canvas-col').getBoundingClientRect()
          const settings = root.querySelector('.settings').getBoundingClientRect()
          if (innerWidth <= 700 ? settings.top < preview.bottom - 1 : settings.left < preview.right - 1) faults.push('preview and controls overlap')
        }
        if (root.matches('.preferences') && innerWidth >= 1440) {
          const box = root.getBoundingClientRect()
          const header = top.parentElement.getBoundingClientRect()
          if (Math.abs(header.left - box.left) > 1 || Math.abs(header.right - box.right) > 1) faults.push('settings header alignment')
        }
        if (root.matches('.script-desk') && innerWidth <= 620) {
          const firstShot = root.querySelector('.shot-list h3')
          if (firstShot && firstShot.getBoundingClientRect().top > innerHeight - 48) faults.push('first shot starts offscreen')
        }
        if (root.matches('.script-desk')) {
          const copy = root.querySelector('.shot-copy').getBoundingClientRect()
          const tools = root.querySelector('.shot-tools').getBoundingClientRect()
          if (width >= 1440 && (tools.left < copy.right || Math.abs(tools.top - copy.top) > 1)) faults.push('wide shot tools are not beside the text')
          if (width <= 1190 && tools.top < copy.bottom - 1) faults.push('compact shot tools overlap the text')
        }
        const footer = root.querySelector('.modal-actions')
        if (footer && footer.getBoundingClientRect().bottom > innerHeight + 1) faults.push('dialog buttons clipped')
        return [...new Set(faults)]
      }, { selector, width, scale })
      if (problems.length) issues.push(name + ' ' + width + '@' + scale + ': ' + problems.join(', '))
      if (selector === '.script-desk' && width >= 1920) {
        const columns = await page.locator(selector).evaluate(el => getComputedStyle(el).gridTemplateColumns)
        console.log('Script columns at ' + width + 'px: ' + columns)
      }
      if (capture && ([320,760,1190,1920].includes(width) || (scale === 2 && name === '创作台'))) {
        await shot(name + '-' + width + (scale === 1 ? '' : '@' + scale), surface)
      }
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await page.setViewportSize({ width:1190, height:772 })
  }
  await page.evaluate(async () => {
    for (const [name, host] of [['星桥中转站', 'bridge'], ['云帆中转站', 'sail']]) {
      const base = 'https://' + host + '.example/v1'
      await window.studio.save({ name, base, protocol:'openai-image', model:'studio-image', models:['studio-image-fast'], serviceGroup:'relay', key:'' })
      await window.studio.saveWriter({ id:'@new', name, base, model:'writer-pro', models:['writer-fast'], serviceGroup:'relay', key:host === 'bridge' ? 'local-ui-fixture' : '', activate:host === 'bridge' })
    }
    await window.studio.setDeveloperMode(true)
  })
  await page.reload()
  await button('请求记录').waitFor()
  await inspect('创作台', '.work', true)
  await button('视频').click()
  await inspect('视频', '.work')
  await button('后台任务').click()
  await inspect('后台任务', 'dialog[open]', true)
  await page.keyboard.press('Escape')
  await button('请求记录').click()
  await inspect('请求记录', 'dialog[open]')
  await page.keyboard.press('Escape')
  await button('作品库').click()
  await inspect('作品库', '.library-page', true)
  await button('剧本').click()
  const sidebarViewport = {width:1440,height:1000}
  await page.setViewportSize(sidebarViewport)
  const sidebar = page.getByRole('complementary', {name:'剧本工具'})
  const history = sidebar.getByRole('region', {name:'我的剧本'})
  await history.getByText('新建或导入的剧本会显示在这里。').waitFor()
  await shot('剧本侧栏-空列表', sidebar)
  const transfer = history.getByRole('button', {name:'项目备份与迁移', exact:true})
  const transferDialog = page.getByRole('dialog', {name:'项目备份与迁移'})
  await transfer.click()
  await transferDialog.getByRole('button', {name:'选择项目备份'}).waitFor()
  assert.equal(await transferDialog.getByRole('button', {name:'备份当前剧本'}).count(), 0)
  await page.keyboard.press('Escape')
  await transferDialog.waitFor({state:'hidden'})
  await page.setViewportSize({width:480,height:640})
  await page.getByLabel('故事构想').waitFor()
  assert.equal(await button('新建与切换剧本').count(), 0)
  await page.evaluate(async () => {
    const scene = {id:'',heading:'车站 · 清晨',action:'列车开过站台。',dialogue:'',imagePrompt:'清晨的站台',videoPrompt:'镜头跟随列车'}
    for (const title of ['群山的回声', '雨停之前', '沿海铁路观察手记 · 从南岸货运站到最后一座灯塔', '渡口来信']) {
      const scenes = title === '群山的回声' ? Array.from({length:8}, (_, i) => ({...scene, heading:'站台 · 第' + (i+1) + '班车'})) : [scene]
      await window.studio.createScript({title, scenes})
    }
  })
  await page.evaluate(() => window.studio.createScript({ title:'潮汐灯塔的最后一班渡轮', scenes:[
    {id:'',heading:'码头 · 夜',action:'末班渡轮解开缆绳。阿岚站在跳板尽头，看着父亲收起岸边最后一盏提灯。',dialogue:'明天见。',imagePrompt:'蓝灰色渡口，钨丝灯照亮湿漉漉的跳板。',videoPrompt:'镜头缓慢后移，渡轮离开码头。'},
    {id:'',heading:'驾驶室 · 雾中',action:'窗外的灯塔隐入海雾。船长关掉顶灯，让眼睛适应黑暗，桌上的航海图映着仪表的绿光。',dialogue:'先听雾号。',imagePrompt:'夜航驾驶室，玻璃窗映出仪表灯。',videoPrompt:'镜头从航海图抬向窗外。'},
    {id:'',heading:'灯塔 · 黎明',action:'天色渐亮，灯塔重新显出轮廓。阿岚推开舱门，父亲的提灯还亮在对岸。',dialogue:'我看见你了。',imagePrompt:'晨雾散开，远岸有一盏暖色提灯。',videoPrompt:'从甲板缓推到远处的灯光。'},
  ] }))
  await page.reload()
  await button('剧本').click()
  await page.getByRole('heading',{name:'潮汐灯塔的最后一班渡轮'}).waitFor()
  await inspect('剧本', '.script-desk', true)
  const items = history.getByRole('list').getByRole('button')
  assert.equal(await items.count(), 5)
  await page.setViewportSize(sidebarViewport)
  await shot('剧本侧栏-已有剧本', sidebar)
  await page.setViewportSize({width:760,height:540})
  const manuscript = page.locator('.manuscript')
  assert.ok(await manuscript.evaluate(el => { el.scrollTop = el.scrollHeight; return el.scrollTop > 0 }))
  await items.last().focus()
  assert.ok(await sidebar.evaluate(el => el.scrollTop > 0), 'long history scrolls inside the sidebar')
  assert.ok(await manuscript.evaluate(el => el.scrollTop > 0), 'browsing history preserves the reading position')
  await items.last().press('Enter')
  await page.locator('.manuscript-title').getByRole('heading', {name:await items.last().locator('b').innerText(),exact:true}).waitFor()
  assert.equal(await items.last().getAttribute('aria-current'), 'true')
  assert.equal(await manuscript.evaluate(el => el.scrollTop), 0, 'switching scripts starts at the top')
  await transfer.click()
  await transferDialog.getByRole('button', {name:'备份当前剧本'}).waitFor()
  await page.keyboard.press('Escape')
  await transferDialog.waitFor({state:'hidden'})
  await page.setViewportSize({width:480,height:640})
  const scriptTools = button('新建与切换剧本')
  await scriptTools.focus()
  await scriptTools.press('Space')
  await page.getByLabel('故事构想').waitFor()
  const expanded = await page.locator('.script-desk').evaluate(el => ({
    sidebarBottom: el.querySelector('.writing-sidebar').getBoundingClientRect().bottom,
    listBottom: el.querySelector('.script-history').getBoundingClientRect().bottom,
    manuscriptTop: el.querySelector('.manuscript').getBoundingClientRect().top,
  }))
  assert.ok(expanded.listBottom <= expanded.sidebarBottom + 1 && expanded.sidebarBottom <= expanded.manuscriptTop + 1,
    'expanded mobile history must fit above the manuscript: ' + JSON.stringify(expanded))
  await page.locator('.script-history button').first().click()
  assert.equal(await scriptTools.getAttribute('aria-expanded'), 'false')
  await page.waitForFunction(() => document.activeElement?.classList.contains('writing-tools-toggle'))
  await page.setViewportSize({width:1190,height:772})
  await button('设置').click()
  for (const section of ['图片与视频','剧本模型','对象存储','性能','文件与工具','开发者模式','软件更新']) {
    await button(section).click()
    if (['图片与视频','剧本模型'].includes(section)) {
      assert.equal(await page.getByRole('region', {name:'中转站与自定义接口', exact:true}).getByRole('article').count(), 2)
    }
    await inspect(section, '.preferences', ['图片与视频','剧本模型','文件与工具'].includes(section))
    if (section === '图片与视频' || section === '剧本模型') {
      await button(section === '图片与视频' ? '添加模型服务' : '添加剧本服务').click()
      await inspect(section + '连接', 'dialog[open]', true)
      await page.keyboard.press('Escape')
    }
  }
  await cdp.detach()
  assert.deepEqual(issues, [], 'Responsive layout regressions:\n' + issues.join('\n'))
  console.log('Responsive layout passed across ' + sizes.length + ' viewport and density combinations, four workspaces, six settings pages and desktop dialogs.')
}

// Use a fresh WebView so the previous suite's emulated viewport cannot mask a native resize.
export async function exerciseMaximizedScript({ page, shot }) {
  const toggleMaximize = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|internal_toggle_maximize'))
  const wasMaximized = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|is_maximized'))
  if (!wasMaximized) await toggleMaximize()
  try {
    await page.waitForFunction(async () => {
      const native = name => window.__TAURI_INTERNALS__.invoke('plugin:window|' + name)
      const [maximized, size, scale] = await Promise.all([native('is_maximized'), native('inner_size'), native('scale_factor')])
      return maximized && Math.abs(innerWidth - size.width / scale) < 2 && Math.abs(innerWidth - screen.availWidth) < 20
    })
    const create = await page.locator('.work').boundingBox()
    const appearance = el => {
      const style = getComputedStyle(el)
      return [style.backgroundColor, style.borderTop, style.borderTopLeftRadius]
    }
    const generationPanel = await page.locator('.work .settings').evaluate(appearance)
    await page.getByRole('button', {name:'剧本', exact:true}).click()
    const firstPrompt = page.locator('.shot-tools summary').first()
    await firstPrompt.click()
    const script = await page.locator('.script-desk').boundingBox()
    assert.ok(Math.abs(script.x - create.x) <= 1 && Math.abs(script.width - create.width) <= 1, 'maximized workspaces align')
    const size = await page.evaluate(() => ({
      viewport: innerWidth, monitor: screen.availWidth, shell: document.querySelector('.shell').clientWidth,
      columns: getComputedStyle(document.querySelector('.script-desk')).gridTemplateColumns,
    }))
    assert.ok(Math.abs(size.shell - size.monitor) < 20 && size.shell === size.viewport, 'workspace fills the maximized client area')
    const sidebar = page.getByRole('complementary', {name:'剧本工具'})
    assert.deepEqual(await sidebar.evaluate(appearance), generationPanel, 'script tools share the generation panel surface')
    assert.ok(await sidebar.getByRole('region', {name:'我的剧本'}).evaluate(el => {
      const style = getComputedStyle(el)
      return style.borderTopStyle === 'solid' && parseFloat(style.borderTopWidth) * devicePixelRatio >= 0.99
        && style.borderTopColor === getComputedStyle(el.closest('aside')).borderTopColor
    }), 'history has a visible divider matching the panel border')
    console.log('Native maximized script: ' + JSON.stringify(size))
    await shot('剧本-最大化', page)
    const actions = page.getByRole('group', {name:'剧本操作'})
    for (const name of ['编辑剧本', '镜头队列', '整片预览与交付']) {
      await actions.getByRole('button', {name, exact:true}).click()
      const dialog = page.getByRole('dialog', {name, exact:true})
      await dialog.waitFor()
      await page.keyboard.press('Escape')
      await dialog.waitFor({state:'hidden'})
    }
  } finally {
    if (!wasMaximized) await toggleMaximize()
  }
}
