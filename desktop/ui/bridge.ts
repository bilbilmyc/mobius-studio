import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { Bridge } from '../shared'
import { sizedExport } from './gpuExport'
import type { PerformanceMode } from '../shared'
const api: Bridge = {
  thumbnail: (id) => invoke('job_thumbnail', { id }),
  savePerformance: (mode) => invoke('save_performance', { mode }),
  setFinal: (scriptId, sceneId, kind, jobId) => invoke('set_final', { scriptId, sceneId, kind, jobId }),
  settings: () => invoke('integration_settings'),
  saveWriter: (input) => invoke('save_writer', { input }),
  saveStorage: (target, secret) => invoke('save_storage', { target, secret }),
  uploadImage: (id) => invoke('upload_image', { id }),
  copyImage: (id, link) => invoke('copy_job_image', { id, link }),
  scripts: () => invoke('list_scripts'),
  generateScript: (brief, count) => invoke('generate_script', { brief, count }),
  editScript: (id, story) => invoke('edit_script', { id, story }),
  exportFile: async (id, resize, chooseLocation) => resize
    ? (await api.exportSized(id, resize, chooseLocation)).path
    : invoke('export_job', { id, resize, chooseLocation }),
  exportSized: async (id, resize, choose) => sizedExport(id, resize, choose, await invoke<PerformanceMode>('performance_mode')),
  link: (kind, url) => invoke('add_link', { kind, url }),
  preview: (item) => invoke('asset_preview', { item }),
  state: () => invoke('studio_state'),
  changedJobs: ids => invoke('changed_jobs', { ids }),
  save: (input) => invoke('edit_profile', { input }),
  remove: (id) => invoke('remove_profile', { id }),
  models: (input) => invoke('list_models', { input }),
  discoverModels: (input) => invoke('discover_models', { input }),
  pick: (kind, multiple) => invoke('pick_files', { kind, multiple }),
  drop: (kind, paths) => invoke('add_files', { kind, paths }),
  frame: (id) => invoke('job_frame', { id }),
  start: (input) => invoke('start_job', { input }),
  resume: (id) => invoke('resume_job', { id }),
  reuse: (id) => invoke('reuse_job', { id }),
  open: (id) => invoke('open_file', { id }),
  folder: () => invoke('open_folder'),
  web: (prompt) => invoke('open_web', { prompt }),
  changed: (cb) => {
    const off = listen<string | null>('jobs-changed', event => cb(event.payload ?? undefined))
    return () => {
      void off.then((fn) => fn())
    }
  },
}
window.studio = api
