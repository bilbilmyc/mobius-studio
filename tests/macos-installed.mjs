import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { verifyPut } from './workspace-flows.mjs'

const [binary, data] = process.argv.slice(2)
const id = randomUUID().replaceAll('-', '')
const secondId = randomUUID().replaceAll('-', '')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQqHkGAAJaAYvrcg4EAAAAAElFTkSuQmCC', 'base64')
const downloads = new Set(), uploaded = new Set()
const firstStarted = Promise.withResolvers(), secondUploaded = Promise.withResolvers()
let puts = 0, fault
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && ['/original.png', '/second.png'].includes(req.url)) {
      assert.ok(!downloads.has(req.url), 'a recovered job downloaded its original twice')
      downloads.add(req.url)
      if (req.url === '/original.png') {
        firstStarted.resolve()
        await secondUploaded.promise
      } else await firstStarted.promise
      res.setHeader('Content-Type', 'image/png')
      res.end(png)
      return
    }
    const url = new URL(req.url, 'http://' + req.headers.host)
    puts++
    const target = [id, secondId].find(jobId => url.pathname === '/test-bucket/stills/' + jobId + '.png')
    assert.ok(target)
    assert.equal(req.method, 'PUT')
    verifyPut(req, url)
    const received = []
    for await (const chunk of req) received.push(chunk)
    assert.deepEqual(Buffer.concat(received), png)
    assert.ok(!uploaded.has(target), 'a recovered job uploaded twice')
    uploaded.add(target)
    res.end()
    if (target === secondId) secondUploaded.resolve()
  } catch (e) { fault = e; res.writeHead(400); res.end() }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const endpoint = 'http://127.0.0.1:' + server.address().port
const account = id + '@' + endpoint, service = 'com.mobius.creative.studio'
const record = path.join(data, 'tasks', id + '.json')
const keychain = path.join(path.dirname(data), 'fixture.keychain-db')
const password = randomUUID()
function security(...args) { return execFileSync('security', args, { encoding: 'utf8' }) }
const originalKeychains = security('list-keychains', '-d', 'user').trim().split('\n')
  .map(line => line.trim().replace(/^"|"$/g, '')).filter(Boolean)
let child, keychainCreated = false, log = ''
try {
  await mkdir(path.dirname(record), { recursive: true })
  // macOS identifies an ad-hoc signed client by the code directory hash. Set that
  // partition explicitly for the synthetic item in its own temporary Keychain.
  const info = spawnSync('codesign', ['--display', '--verbose=4', binary], { encoding: 'utf8' })
  assert.equal(info.status, 0, info.stderr)
  const cdhash = info.stderr.match(/^CDHash=([0-9a-f]+)$/mi)?.[1].toLowerCase()
  assert.ok(cdhash, 'missing installed executable code directory hash')
  security('create-keychain', '-p', password, keychain)
  keychainCreated = true
  security('unlock-keychain', '-p', password, keychain)
  security('list-keychains', '-d', 'user', '-s', keychain, ...originalKeychains)
  security('add-generic-password', '-s', service, '-a', account, '-w', 'storage-fixture-secret', '-A', keychain)
  security('set-generic-password-partition-list', '-a', account, '-s', service,
    '-S', 'apple-tool:,cdhash:' + cdhash, '-k', password, keychain)
  await writeFile(path.join(data, 'settings.json'), JSON.stringify({
    storage: { endpoint, bucket: 'test-bucket', prefix: 'stills', region: 'auto', accessKey: 'storage-fixture', automatic: true },
    storageKey: { Id: id, BaseUrl: endpoint, Keys: { ['macos:' + endpoint]: account } },
  }))
  await writeFile(record, JSON.stringify({ Id: id, Status: 'downloading', ProtocolId: 'openai-image',
    BaseUrl: endpoint, ResultUrl: endpoint + '/original.png', CreatedUtc: new Date().toISOString() }))
  const secondRecord = path.join(data, 'tasks', secondId + '.json')
  await writeFile(secondRecord, JSON.stringify({ Id: secondId, Status: 'downloading', ProtocolId: 'openai-image',
    BaseUrl: endpoint, ResultUrl: endpoint + '/second.png', CreatedUtc: new Date().toISOString() }))
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
    throw Error(`Mac upload stalled at ${job.Cloud.status}; GET=${downloads.size} PUT=${puts}\n${sample}\n${stacks.join('\n')}`)
  }
  assert.deepEqual(await readFile(path.join(data, '作品', job.FileName)), png)
  const second = JSON.parse(await readFile(secondRecord, 'utf8'))
  assert.equal(second.Status, 'done')
  assert.equal(second.Cloud?.uri, 's3://test-bucket/stills/' + secondId + '.png')
  assert.notEqual(job.FileName, second.FileName)
  assert.deepEqual(await readFile(path.join(data, '作品', second.FileName)), png)
  assert.equal(uploaded.size, 2)
  console.log('Installed arm64 WebView recovered two concurrent downloads and saved both originals with verified S3 signatures.')
} finally {
  firstStarted.resolve()
  secondUploaded.resolve()
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit')
    child.kill('SIGTERM')
    await stopped
  }
  server.closeAllConnections()
  server.close()
  if (keychainCreated) {
    security('list-keychains', '-d', 'user', '-s', ...originalKeychains)
    security('delete-keychain', keychain)
  }
}
