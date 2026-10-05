// Build documents shared by the two sub-applications.
export type DocKind = 'architect' | 'cao3d'
export type Unit = 'mm' | 'cm' | 'm'

export interface BuildDocumentSummary {
  id: string
  kind: DocKind
  title: string
  unit: Unit
  trashed: boolean
  created_at: string
  updated_at: string
}

export interface BuildDocument extends BuildDocumentSummary {
  // Full scene, schema owned by each editor (opaque to the backend).
  data: unknown
}

export interface CreateDocumentInput {
  kind: DocKind
  title?: string
  unit?: Unit
  data?: unknown
}

export interface UpdateDocumentInput {
  title?: string
  unit?: Unit
  data?: unknown
}
