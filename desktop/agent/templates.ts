import type { MediaKind } from '../shared'

export type TemplateMedium = MediaKind | 'any'
export interface TemplateSpec {
  author?: string
  source?: string
  name: string
  medium: TemplateMedium
  description: string
  body: string
}
export interface PromptTemplate extends TemplateSpec {
  id: string
}
export interface TemplateLibrary {
  revision: number
  entries: PromptTemplate[]
}
export type TemplateChange =
  | { action: 'import'; templates: TemplateSpec[] }
  | { action: 'edit'; id: string; template: TemplateSpec }
  | { action: 'remove'; id: string }
export interface TemplateBridge {
  findPromptTemplates(
    kind: MediaKind,
    query: string
  ): Promise<{ name: string; description: string; body: string; characters: number }[]>
  promptTemplates(): Promise<TemplateLibrary>
  parsePromptTemplates(
    filename: string,
    content: string
  ): Promise<{ templates: TemplateSpec[]; skipped: number }>
  changePromptTemplates(
    revision: number,
    change: TemplateChange
  ): Promise<{
    library: TemplateLibrary
    selected: string | null
    added: number
    skipped: number
    renamed: number
  }>
  exportPromptTemplates(ids: string[], chooseLocation: boolean): Promise<string | null>
}

const placeholder =
  /\{\{\s*([\p{L}_][\p{L}\p{N}_ -]{0,39}?)\s*\}\}|[$]\{([\p{L}_][\p{L}\p{N}_ -]{0,39}?)(?::([^{}\r\n]{0,160}))?\}/gu

export function templateFields(body: string) {
  const fields = new Map<string, string>()
  for (const match of body.matchAll(placeholder)) {
    const name = (match[1] ?? match[2]).trim()
    if (!fields.has(name)) fields.set(name, match[3] ?? '')
  }
  return fields
}

export function fillTemplate(body: string, values: Record<string, string>) {
  return body.replace(
    placeholder,
    (match, first: string | undefined, second: string, fallback: string | undefined) => {
      const name = (first ?? second).trim()
      const value = Object.hasOwn(values, name) ? values[name] : fallback
      return value?.trim() ? value : match
    }
  )
}

export function matchScore(query: string, fields: string[]) {
  const words = query
    .trim()
    .toLowerCase()
    .split(/[\s,，、]+/u)
    .filter(Boolean)
  if (!words.length) return 1
  return fields.reduce((score, field, i) => {
    const text = field.toLowerCase()
    return (
      score + words.reduce((points, word) => points + (text.includes(word) ? fields.length - i : 0), 0)
    )
  }, 0)
}
