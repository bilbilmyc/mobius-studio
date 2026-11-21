import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, copyFile, readFile, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'

const { values: options } = parseArgs({
  options: { 'require-gpu': { type: 'boolean' }, report: { type: 'string' } },
})
const root = fileURLToPath(new URL('../', import.meta.url))
const release = path.resolve(root, process.env.CARGO_TARGET_DIR || 'src-tauri/target', 'release')
const suffix = process.platform === 'win32' ? '.exe' : ''
const fixtureRoot = await realpath(os.tmpdir()),
  temp = await mkdtemp(path.join(fixtureRoot, 'mobius-4k-'))
const id = 'f'.repeat(32)
async function run(mode) {
  const data = path.join(temp, mode)
  await mkdir(path.join(data, 'tasks'), { recursive: true })
  await mkdir(path.join(data, '作品'))
  await copyFile(path.join(root, 'src/orbit.png'), path.join(data, '作品', 'fixture.png'))
  await writeFile(path.join(data, '.render-fixture'), '')
  await writeFile(path.join(data, 'settings.json'), JSON.stringify({ performance: mode }))
  await writeFile(
    path.join(data, 'tasks', id + '.json'),
    JSON.stringify({
      Id: id,
      Status: 'done',
      ProtocolId: 'rh-image',
      FileName: 'fixture.png',
      Prompt: 'Mobius 4K fixture',
    }),
  )
  const child = spawn(path.join(release, 'mobius-studio' + suffix), [], {
    cwd: data,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      MOBIUS_HOME: data,
      MOBIUS_RENDER_BENCHMARK: '1',
      WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview'),
    },
  })
  let peakMiB = null
  try {
    for (let i = 0; i < 450; i++) {
      assert.equal(child.exitCode, null, 'Benchmark app exited early')
      if (process.platform === 'darwin') {
        const rss = Number(
          execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' }).trim(),
        )
        peakMiB = Math.max(peakMiB ?? 0, rss / 1024)
      }
      let text
      try {
        text = await readFile(path.join(data, 'render-result.json'), 'utf8')
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
      if (text) {
        const report = JSON.parse(text)
        assert.ok(!report.error, report.error)
        assert.equal(report.times.length, 3)
        if (process.platform === 'win32')
          peakMiB = Number(
            execFileSync(
              'powershell.exe',
              [
                '-NoProfile',
                '-Command',
                '(Get-Process -Id ' + child.pid + ').PeakWorkingSet64 / 1MB',
              ],
              { encoding: 'utf8', windowsHide: true },
            ).trim(),
          )
        if (process.platform === 'linux') {
          const hwm = (await readFile('/proc/' + child.pid + '/status', 'utf8')).match(
            /^VmHWM:\s+(\d+)/m,
          )
          if (hwm) peakMiB = Number(hwm[1]) / 1024
        }
        const engines = [...new Set(report.results.map((x) => x.engine))]
        if (mode === 'auto') assert.deepEqual(engines, ['CPU'])
        else if (options['require-gpu'])
          assert.deepEqual(engines, ['GPU'], report.results[0].fallback)
        return {
          timesMs: report.times,
          medianMs: [...report.times].sort((a, b) => a - b)[1],
          engines,
          renderer: report.renderer,
          mainProcessPeakMiB: peakMiB === null ? null : Math.round(peakMiB),
          memoryMethod: process.platform === 'darwin' ? 'sampled RSS' : 'OS high-water mark',
          fallback: report.results.find((x) => x.fallback)?.fallback,
          file: report.results[0].path,
        }
      }
      await delay(200)
    }
    throw Error('Timed out waiting for real WebView export results')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit')
      child.kill()
      await stopped
    }
  }
}
try {
  const cpu = await run('auto'),
    performance = await run('performance')
  const quality = JSON.parse(
    execFileSync(
      path.join(release, 'examples', 'compare_exports' + suffix),
      [cpu.file, performance.file],
      { encoding: 'utf8' },
    ),
  )
  delete cpu.file
  delete performance.file
  const report = JSON.stringify(
    {
      platform: os.platform(),
      arch: os.arch(),
      cpu,
      performance,
      quality,
      hardwareMeasured: performance.engines.length === 1 && performance.engines[0] === 'GPU',
    },
    null,
    2,
  )
  console.log(report)
  if (options.report) await writeFile(options.report, report + '\n')
} finally {
  const real = await realpath(temp)
  assert.equal(path.dirname(real), fixtureRoot)
  assert.ok(path.basename(real).startsWith('mobius-4k-'))
  await rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
