import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { waitForValue } from './wait-for-value.mjs'

function shellAction(pid, script) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, MOBIUS_TEST_PID: String(pid) }, windowsHide: true, encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
}

function closeWindow(pid) {
  shellAction(pid, 'if (-not ([Diagnostics.Process]::GetProcessById([int]$env:MOBIUS_TEST_PID)).CloseMainWindow()) { exit 1 }')
}

// Deliver the same left-button release as Explorer to the disposable process's tray window.
// tray-icon 0.25 registers tray_icon_app and uses 6002 as its Shell_NotifyIcon callback.
function clickTray(pid) {
  shellAction(pid, `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TrayClick {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr root, IntPtr after, string type, string name);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint msg, IntPtr wparam, IntPtr lparam);
  public static bool Send(uint pid) {
    IntPtr window = IntPtr.Zero;
    while ((window = FindWindowEx(IntPtr.Zero, window, "tray_icon_app", null)) != IntPtr.Zero) {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      if (owner == pid) return PostMessage(window, 6002, IntPtr.Zero, (IntPtr)0x202);
    }
    return false;
  }
}
'@
if (-not [TrayClick]::Send([uint32]$env:MOBIUS_TEST_PID)) { exit 1 }`)
}

function resizeWindow(pid, width, height) {
  shellAction(pid, `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WindowSize {
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int l, t, r, b; }
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int w, int h, uint flags);
  public static bool Set(IntPtr window, int width, int height) {
    SetThreadDpiAwarenessContext((IntPtr)(-4));
    Rect client, outer;
    if (!GetClientRect(window, out client) || !GetWindowRect(window, out outer)) return false;
    double scale = GetDpiForWindow(window) / 96.0;
    return SetWindowPos(window, IntPtr.Zero, 0, 0,
      (int)Math.Round(width * scale) + outer.r - outer.l - client.r,
      (int)Math.Round(height * scale) + outer.b - outer.t - client.b, 0x16);
  }
}
'@
$handle = ([Diagnostics.Process]::GetProcessById([int]$env:MOBIUS_TEST_PID)).MainWindowHandle
if (-not [WindowSize]::Set($handle, ${width}, ${height})) { exit 1 }`)
}

export function lifecycleFixture(png) {
  const release = Promise.withResolvers()
  let submitted = 0
  return { release, submitted: () => submitted, async handle(req, res, bytes) {
    res.setHeader('Content-Type', 'application/json')
    if (req.url.endsWith('/images/generations')) {
      submitted++
      if (JSON.parse(bytes).prompt === 'private-failing-prompt') {
        res.writeHead(403)
        return res.end(JSON.stringify({ error: { message: 'private-upstream-text https://secret.example/file?sig=private-signature' } }))
      }
      await release.promise
      return res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
    }
    throw Error('Unexpected fixture route')
  }}
}

export async function exerciseLifecycle({ page, data, base, currentPid, fixture, restart, shot }) {
  const pid = currentPid()
  const info = await page.evaluate(() => window.studio.runtimeInfo())
  assert.ok(info.tray)
  assert.equal(path.resolve(info.logFile), path.join(data, 'logs', 'mobius.log'))
  const log = () => readFile(info.logFile, 'utf8')
  const visible = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'main' }))
  const id = await page.evaluate(base => window.studio.save({
    name:'测试服务', protocol:'openai-image', base, model:'test-model', key:'private-runtime-key',
  }), base)
  const generate = prompt => page.evaluate(({id, prompt}) => window.studio.start({
    profileId:id, kind:'image', template:'', prompt, size:'1024x1024', seconds:0, config:{mode:'t2i'}, priority:0, assets:[],
  }), {id, prompt})
  const status = id => page.evaluate(async id => (await window.studio.state()).jobs.find(j => j.id === id), id)
  const task = await generate('private-running-prompt')
  await waitForValue(() => fixture.submitted() === 1, 'local image submission')
  closeWindow(pid)
  await waitForValue(async () => !await visible(), 'X to hide the window')
  fixture.release.resolve()
  await waitForValue(async () => (await status(task))?.file, 'saved image while hidden')
  assert.equal(await visible(), false)
  assert.equal(fixture.submitted(), 1)
  clickTray(pid)
  await waitForValue(visible, 'tray click to restore the same window')
  const initial = await page.evaluate(() => [innerWidth, innerHeight])
  resizeWindow(pid, 480, 540)
  await waitForValue(() => page.evaluate(() => Math.abs(innerWidth - 480) <= 1 && Math.abs(innerHeight - 540) <= 1
    && document.querySelector('.rail').getBoundingClientRect().top > innerHeight / 2), 'native narrow window with bottom navigation')
  resizeWindow(pid, ...initial)
  await waitForValue(() => page.evaluate(width => Math.abs(innerWidth - width) <= 1, initial[0]), 'restored native window size')

  const failed = await generate('private-failing-prompt')
  await waitForValue(async () => (await status(failed))?.status === 'failed', 'failed task')
  await page.evaluate(async () => {
    await window.studio.selectWriter('missing', 'private-model').catch(() => {})
    window.dispatchEvent(new ErrorEvent('error', { error: new TypeError('private-script-message'), lineno: 23, colno: 17 }))
  })
  await waitForValue(async () => (await log()).includes('TypeError') && (await log()).includes('select_writer'), 'persistent UI errors')
  const before = await log()
  assert.ok(before.includes(failed) && before.includes('HTTP 403') && before.includes('已收起到托盘'))
  assert.doesNotMatch(before, /private-|secret\.example/)
  const button = name => page.getByRole('button', {name, exact:true})
  await button('设置').click()
  await button('文件与工具').click()
  await page.getByText(info.logFile, {exact:true}).waitFor()
  await button('打开日志目录').waitFor()
  await shot('后台运行与日志', page.locator('.preferences-content'))
  page = await restart(() => button('退出应用').click())
  const after = await log()
  assert.ok(after.includes(failed) && after.includes('应用已退出') && after.lastIndexOf('启动') > after.indexOf('应用已退出'))
  assert.equal((await status(task)).status, 'done')
  assert.equal(fixture.submitted(), 2)
  closeWindow(currentPid())
  await waitForValue(async () => !await visible(), 'restarted window to hide')
  // The tray's quit menu calls the same native request while the WebView is hidden.
  page = await restart()
  assert.equal((await log()).split('应用已退出').length - 1, 2)
  console.log('Window lifecycle passed: native close, background completion, Windows tray restore, explicit exit, restart and safe persistent logs.')
}
