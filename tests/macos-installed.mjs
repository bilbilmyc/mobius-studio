import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { verifyPut } from './workspace-flows.mjs'

const [binary, data] = process.argv.slice(2)
const id = randomUUID().replaceAll('-', '')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQqHkGAAJaAYvrcg4EAAAAAElFTkSuQmCC', 'base64')
let downloads = 0, puts = 0, uploaded = 0, fault
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/original.png') {
      downloads++
      res.setHeader('Content-Type', 'image/png')
      res.end(png)
      return
    }
    const url = new URL(req.url, 'http://' + req.headers.host)
    puts++
    assert.equal(url.pathname, '/test-bucket/stills/' + id + '.png')
    assert.equal(req.method, 'PUT')
    verifyPut(req, url)
    const received = []
    for await (const chunk of req) received.push(chunk)
    assert.deepEqual(Buffer.concat(received), png)
    uploaded++
    res.end()
  } catch (e) { fault = e; res.writeHead(400); res.end() }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const endpoint = 'http://127.0.0.1:' + server.address().port
const account = id + '@' + endpoint, service = 'com.mobius.creative.studio'
const record = path.join(data, 'tasks', id + '.json')
let child, keyCreated = false, log = ''
try {
  await mkdir(path.dirname(record), { recursive: true })
  // The CLI creates the synthetic item on behalf of an ad-hoc signed app. Let the
  // headless runner read just this disposable fixture without a Keychain consent dialog.
  execFileSync('security', ['add-generic-password', '-s', service, '-a', account,
    '-w', 'storage-fixture-secret', '-A'])
  keyCreated = true
  await writeFile(path.join(data, 'settings.json'), JSON.stringify({
    storage: { endpoint, bucket: 'test-bucket', prefix: 'stills', region: 'auto', accessKey: 'storage-fixture', automatic: true },
    storageKey: { Id: id, BaseUrl: endpoint, Keys: { ['macos:' + endpoint]: account } },
  }))
  await writeFile(record, JSON.stringify({ Id: id, Status: 'downloading', ProtocolId: 'openai-image',
    BaseUrl: endpoint, ResultUrl: endpoint + '/original.png', CreatedUtc: new Date().toISOString() }))
  child = spawn(binary, [], { env: { ...process.env, MOBIUS_HOME: data, MOBIUS_SMOKE_TEST: '1' } })
  child.stdout.on('data', chunk => { log += chunk })
  child.stderr.on('data', chunk => { log += chunk })
  child.on('error', error => { fault = error })
  let job
  for (let attempt = 0; attempt < 120; attempt++) {
    if (fault) throw fault
    assert.equal(child.exitCode, null, log)
    assert.equal(child.signalCode, null, log)
    job = JSON.parse(await readFile(record, 'utf8'))
    if (job.Cloud?.status === 'failed') throw Error(job.Cloud.detail)
    if (job.Cloud?.status === 'saved' && log.includes('MOBIUS_WEBVIEW_READY')) break
    await delay(500)
  }
  assert.ok(log.includes('MOBIUS_WEBVIEW_READY'), log)
  assert.equal(job.Status, 'done')
  assert.equal(job.Cloud?.uri, 's3://test-bucket/stills/' + id + '.png')
  if (job.Cloud.status !== 'saved') {
    const sample = execFileSync('sample', [String(child.pid), '1', '-file', path.join(data, 'sample.txt')], {encoding:'utf8'})
    const stacks = (await readFile(path.join(data, 'sample.txt'), 'utf8')).split('\n')
      .filter(line => /SecItemCopyMatching|SecKeychain|put_image|vault::|upload_image/.test(line)).slice(0, 14)
    throw Error(`Mac upload stalled at ${job.Cloud.status}; GET=${downloads} PUT=${puts}\n${sample}\n${stacks.join('\n')}`)
  }
  assert.deepEqual(await readFile(path.join(data, '作品', job.FileName)), png)
  assert.equal(uploaded, 1)
  console.log('Installed arm64 app started its WebView, recovered a download, and uploaded the original PNG with a verified S3 signature.')
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit')
    child.kill('SIGTERM')
    await stopped
  }
  server.closeAllConnections()
  server.close()
  if (keyCreated) execFileSync('security', ['delete-generic-password', '-s', service, '-a', account])
}
