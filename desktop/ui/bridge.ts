import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { Bridge } from '../shared'
import { sizedExport } from './gpuExport'
import type { PerformanceMode } from '../shared'
const api: Bridge = {
  promptSession: scope => invoke('prompt_session', { scope }),
  updatePromptSession: (scope, revision, turn) => invoke('update_prompt_session', { scope, revision, turn }),
  savePromptMemory: (scope, previous, memory) => invoke('save_prompt_memory', { scope, previous, memory }),
  promptShotContext: shot => invoke('prompt_shot_context', { shot }),
  promptAgentStep: (target, messages, run) => invoke('prompt_agent_step', { target, messages, run }),
  finishPromptRun: id => invoke('finish_prompt_run', {id}),
  findPromptTemplates: (kind,query) => invoke('find_prompt_templates',{kind,query}),
  promptTemplates: () => invoke('prompt_templates'),
  parsePromptTemplates: (filename,content) => invoke('parse_prompt_templates', {filename,content}),
  changePromptTemplates: (revision,change) => invoke('change_prompt_templates', {revision,change}),
  exportPromptTemplates: (ids,chooseLocation) => invoke('export_prompt_templates',{ids,chooseLocation}),
  optimizePrompt: input => invoke('optimize_prompt', { input }),
  createScript: story => invoke('create_script', { story }),
  shotDrafts: () => invoke('list_shot_drafts'),
  saveShotDraft: (draft, picks) => invoke('save_shot_draft', { draft, picks }),
  startComparison: inputs => invoke('start_comparison', { inputs }),
  selectComparison: (id, jobId) => invoke('select_comparison', { id, jobId }),
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
  copyTaskInfo: id => invoke('copy_task_info', { id }),
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
