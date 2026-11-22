import { setTimeout as delay } from 'node:timers/promises'

// Native IPC resolves asynchronously. Poll its resolved value, not the Promise returned to the browser.
export async function waitForValue(read, description, timeout = 30000) {
  const deadline = performance.now() + timeout
  do {
    const value = await read()
    if (value) return value
    await delay(80)
  } while (performance.now() < deadline)
  throw new Error(`Timed out waiting for ${description}`)
}
