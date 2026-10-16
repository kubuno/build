import { api } from '@kubuno/sdk'
import type { BuildDocument, BuildDocumentSummary, CreateDocumentInput, DocKind, Unit, UpdateDocumentInput } from './types'

// All requests are proxied by the core to the build module (base `/api/v1`).
const BASE = '/build'

// ── Instance settings published to the client ────────────────────────────────
// The two knobs below describe EDITOR behaviour, so the server has nothing to
// apply: `module.toml` marks them `public = true` and the core serves them from
// `/api/v1/config` under `build.<key>`. Read once per page load; an unreadable
// or out-of-range value falls back to the same factory default the manifest
// declares, never to a permissive one.

export interface BuildPublicConfig {
  /** Unit given to a newly created document. */
  defaultUnit: Unit
  /** Seconds between two automatic saves; 0 disables auto-saving. */
  autosaveIntervalS: number
}

export const DEFAULT_PUBLIC_CONFIG: BuildPublicConfig = { defaultUnit: 'mm', autosaveIntervalS: 20 }

function readUnit(value: unknown): Unit {
  return value === 'mm' || value === 'cm' || value === 'm' ? value : DEFAULT_PUBLIC_CONFIG.defaultUnit
}

function readInterval(value: unknown): number {
  // An empty string means "unset", not "0" - Number('') would say 0 and silently
  // disable auto-saving.
  const text = typeof value === 'string' ? value.trim() : ''
  const n = typeof value === 'number' ? value : text === '' ? NaN : Number(text)
  // Bounds mirror the min/max declared in module.toml.
  return Number.isFinite(n) && n >= 0 && n <= 3600 ? Math.round(n) : DEFAULT_PUBLIC_CONFIG.autosaveIntervalS
}

let configPromise: Promise<BuildPublicConfig> | null = null

export function loadPublicConfig(): Promise<BuildPublicConfig> {
  configPromise ??= api.get<{ config: Record<string, unknown> }>('/config')
    .then(({ data }) => {
      const cfg = data?.config ?? {}
      return {
        defaultUnit: readUnit(cfg['build.default_unit']),
        autosaveIntervalS: readInterval(cfg['build.autosave_interval_s']),
      }
    })
    .catch(() => DEFAULT_PUBLIC_CONFIG)
  return configPromise
}

export const buildApi = {
  async list(kind?: DocKind, trashed = false): Promise<BuildDocumentSummary[]> {
    const params = new URLSearchParams()
    if (kind) params.set('kind', kind)
    if (trashed) params.set('trashed', 'true')
    const q = params.toString()
    const { data } = await api.get<BuildDocumentSummary[]>(`${BASE}/documents${q ? `?${q}` : ''}`)
    return data
  },
  async get(id: string): Promise<BuildDocument> {
    const { data } = await api.get<BuildDocument>(`${BASE}/documents/${id}`)
    return data
  },
  async create(input: CreateDocumentInput): Promise<BuildDocument> {
    const { data } = await api.post<BuildDocument>(`${BASE}/documents`, input)
    return data
  },
  async update(id: string, patch: UpdateDocumentInput): Promise<BuildDocument> {
    const { data } = await api.patch<BuildDocument>(`${BASE}/documents/${id}`, patch)
    return data
  },
  async trash(id: string): Promise<void> {
    await api.post(`${BASE}/documents/${id}/trash`)
  },
  async restore(id: string): Promise<void> {
    await api.post(`${BASE}/documents/${id}/restore`)
  },
  async remove(id: string): Promise<void> {
    await api.delete(`${BASE}/documents/${id}/delete`)
  },
  async duplicate(id: string): Promise<BuildDocument> {
    const { data } = await api.post<BuildDocument>(`${BASE}/documents/${id}/duplicate`)
    return data
  },
  /** Resolve (or import) the document behind a drive file (.kbarch / .kbcao). */
  async openByFile(fileId: string): Promise<BuildDocument> {
    const { data } = await api.post<BuildDocument>(`${BASE}/documents/open-by-file`, { file_id: fileId })
    return data
  },
}
