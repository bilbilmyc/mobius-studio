// Embedded only in the render-benchmark build; exercises the same export bridge used by the UI.
void (async () => {
  if (window.mobiusRenderProbe) return
  window.mobiusRenderProbe = true
  let report
  try {
    for (let i = 0; i < 150 && !window.studio; i++) await new Promise((r) => setTimeout(r, 100))
    const id = 'f'.repeat(32)
    const state = await window.studio.state()
    if (!state.jobs.some((j) => j.id === id && j.file && j.prompt === 'Mobius 4K fixture'))
      throw Error('Missing isolated rendering fixture')
    const times = [],
      results = []
    for (let i = 0; i < 3; i++) {
      const start = performance.now()
      results.push(
        await window.studio.exportSized(id, { width: 3840, height: 2160, fit: 'crop' }, false),
      )
      times.push(Math.round(performance.now() - start))
    }
    let renderer
    if (results.some((r) => r.engine === 'GPU')) {
      const gl = document
        .createElement('canvas')
        .getContext('webgl2', { failIfMajorPerformanceCaveat: true })
      if (gl) {
        const info = gl.getExtension('WEBGL_debug_renderer_info')
        renderer = gl.getParameter(info?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)
        gl.getExtension('WEBGL_lose_context')?.loseContext()
      }
    }
    report = { times, results, renderer }
  } catch (e) {
    report = { error: String(e) }
  }
  await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {
    event: 'mobius-render-benchmark',
    payload: report,
  })
})()
