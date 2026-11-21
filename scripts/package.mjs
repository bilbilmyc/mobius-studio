import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, readdir, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = resolve(process.env.MOBIUS_DIST || join(root, 'dist'))
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const { values } = parseArgs({ options: {
  arch: { type: 'string' }, installer: { type: 'boolean' },
} })
const platforms = {
  win32: { name: 'Windows', suffix: '-pc-windows-msvc', bundle: 'nsis', extension: '.exe' },
  linux: { name: 'Linux', suffix: '-unknown-linux-gnu', bundle: 'deb', extension: '.deb' },
  darwin: { name: 'macOS', suffix: '-apple-darwin', bundle: 'dmg', extension: '.dmg' },
}
const system = process.platform
const platform = platforms[system]
const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (\S+)/m)?.[1]
if (!host) throw Error('无法确定 Rust 编译器的主机架构')
const hostArch = { x86_64: 'x64', aarch64: 'arm64' }[host.split('-')[0]]
const mac = system === 'darwin'
const installer = mac || values.installer
const arch = values.arch ?? (mac ? 'arm64' : hostArch)
const cpu = { x64: 'x86_64', arm64: 'aarch64' }[arch]
if (!platform || !cpu || (mac && arch !== 'arm64'))
  throw Error('macOS 使用 arm64，Windows 和 Linux 支持 x64 与 arm64。')
const triple = cpu + platform.suffix
const target = triple === host ? '' : triple
const targetDir = resolve(root, process.env.CARGO_TARGET_DIR || 'src-tauri/target')
const release = join(targetDir, target, 'release')
const cli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
const tag = `Mobius-${platform.name}-${arch}`
const webDirectory = `.app-build/bundles/${tag}-${installer ? 'installed' : 'portable'}`
const webConfig = JSON.stringify({ build: { frontendDist: '../' + webDirectory } })

function run(program, args, cwd = root) {
  const result = spawnSync(program, args, {
    cwd, stdio: 'inherit', env: { ...process.env, MOBIUS_UI_OUT: join(root, webDirectory) },
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const flags = installer ? ['--features', 'installed', '--bundles', platform.bundle] : ['--no-bundle']
run(process.execPath, [cli, 'build', '--config', webConfig, ...flags, ...(target ? ['--target', target] : [])])
await mkdir(output, { recursive: true })
if (installer) {
  const dir = join(release, 'bundle', platform.bundle)
  const candidates = (await readdir(dir)).filter((name) =>
    name.includes(`_${version}_`) && name.endsWith(platform.extension))
  if (candidates.length !== 1) throw Error(`未找到唯一的 ${version} 安装包：${dir}`)
  const destination = join(output, `${tag}-${version}${system === 'win32' ? '-setup' : ''}${platform.extension}`)
  await copyFile(join(dir, candidates[0]), destination + '.new')
  await rename(destination + '.new', destination)
  console.log(destination)
} else {
  const portable = join(output, tag)
  await mkdir(portable, { recursive: true })
  const binary = system === 'win32' ? '莫比环.exe' : 'mobius-studio'
  const dest = join(portable, binary)
  await copyFile(join(release, 'mobius-studio' + (system === 'win32' ? '.exe' : '')), dest + '.new')
  if (system === 'linux') await chmod(dest + '.new', 0o755)
  await rename(dest + '.new', dest)
  if (system === 'win32')
    run('tar.exe', ['-a', '-cf', join(output, tag + '.zip'), '--options', 'zip:hdrcharset=UTF-8', binary], portable)
  else run('tar', ['-czf', join(output, tag + '.tar.gz'), binary], portable)
  console.log(portable)
}
