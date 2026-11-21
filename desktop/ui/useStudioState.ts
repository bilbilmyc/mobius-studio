import { useCallback, useEffect, useRef, useState } from 'react'
import type { State } from '../shared'

export function useStudioState(report: (message: string) => void) {
  const [state, setState] = useState<State>()
  const current = useRef<State | undefined>(undefined),
    queue = useRef(Promise.resolve()),
    mounted = useRef(true)
  const refresh = useCallback((ids?: string[]) => {
    const result = queue.current.then(async () => {
      let next: State
      if (ids && current.current) {
        const delta = await window.studio.changedJobs(ids)
        const changed = new Set(delta.map((j) => j.id))
        const jobs = [...delta, ...current.current.jobs.filter((j) => !changed.has(j.id))].sort(
          (a, b) => b.created - a.created || a.id.localeCompare(b.id),
        )
        next = { ...current.current, jobs }
      } else next = await window.studio.state()
      current.current = next
      if (mounted.current) setState(next)
      return next
    })
    queue.current = result.then(
      () => {},
      () => {},
    )
    return result
  }, [])
  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setTimeout> | undefined,
      full = false
    const ids = new Set<string>()
    const fail = (e: unknown) => {
      if (mounted.current) report(String(e))
    }
    const off = window.studio.changed((id) => {
      if (id) ids.add(id)
      else full = true
      timer ??= setTimeout(() => {
        const changed = full ? undefined : [...ids]
        timer = undefined
        full = false
        ids.clear()
        void refresh(changed).catch(fail)
      }, 25)
    })
    void refresh().catch(fail)
    return () => {
      mounted.current = false
      clearTimeout(timer)
      off()
    }
  }, [refresh, report])
  return { state, refresh }
}
