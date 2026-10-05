// Contract between the generic BuildEditor shell and each sub-app's modeling
// engine. The shell owns React state (active tool, selection, view, history) and
// the OfficeShell chrome; the engine owns the three.js scene, pointer handling
// and the document model. They talk through these two interfaces so the shell
// stays identical for Architect and CAO3D.
import type { ViewportHandle } from './Viewport3D'
import type { Unit } from './types'

/** Read-only view of editor state + commands, handed to pages that build ribbons. */
export interface EditorController {
  tool: string
  setTool: (id: string) => void
  view: '2d' | '3d'
  setView: (mode: '2d' | '3d') => void
  hasSelection: boolean
  deleteSelection: () => void
  fitView: () => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  /** True while a sketch is open in the in-place sketch editor. */
  sketchActive: boolean
  /** Fire a one-shot, engine-specific command (extrude, revolve…). */
  run: (command: string, payload?: unknown) => void
}

/** One editable numeric property of the selected element (shown in the panel). */
export interface SelField {
  key: string
  label: string
  value: number
  unit?: string
  min?: number
  step?: number
}

/** Structured description of the current selection for the properties panel. */
export interface SelectionInfo {
  title: string
  fields: SelField[]
  /** Extra count when several elements are selected. */
  count?: number
}

/** One row of the parametric timeline (construction history) panel. */
export interface TimelineItem {
  id: string
  /** Feature type (sketch, pad, revolve, loft, combine…) — picks the icon. */
  type: string
  name: string
  suppressed: boolean
  /** Hidden because a later feature consumed it (sketch under a pad…). */
  consumed: boolean
  /** False when suppressed or beyond the rollback tip. */
  computed: boolean
  error?: string
  selected: boolean
  isTip: boolean
}

export interface EngineContext {
  handle: ViewportHandle
  unit: Unit
  /** Accent colour (hex) for selection highlight / previews. */
  accent: string
  /** Snap step in mm for drawing (0 = free). */
  gridStepMm: number
  initialData: unknown
  /** Called by the engine whenever the model changed (enables Save). */
  onDirty: () => void
  onSelectionChange: (hasSelection: boolean) => void
  /** Structured selection details for the editable properties panel. */
  onSelectionInfo: (info: SelectionInfo | null) => void
  /** Engine may finish a one-shot tool and fall back to select. */
  onToolChange: (tool: string) => void
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void
  /** Parametric engines publish their feature timeline here (null = none). */
  onTimelineChange?: (items: TimelineItem[] | null) => void
  /** Sketch-editing status (null = not editing a sketch). */
  onSketchStatus?: (s: SketchStatus | null) => void
  /** Translate an i18n key with a fallback (feature auto-names, errors). */
  tr?: (key: string, fallback: string) => string
}

/** Live sketch-editor status for the DoF chip + contextual ribbon tab. */
export interface SketchStatus {
  /** Degrees of freedom left (0 = fully constrained). */
  dof: number
  /** Number of conflicting constraints (solver diagnostics). */
  conflicting: number
  /** False when the last solve failed. */
  solved: boolean
}

export interface BuildEngine {
  setTool: (id: string) => void
  setView: (mode: '2d' | '3d') => void
  deleteSelection: () => void
  /** Snapshot the current selection into the internal clipboard. */
  copySelection: () => void
  /** Copy then delete the current selection. */
  cutSelection: () => void
  /** Re-insert the clipboard as fresh, slightly offset duplicates. */
  paste: () => void
  fitView: () => void
  undo: () => void
  redo: () => void
  /** Engine-specific one-shot command (extrude, revolve…). */
  command: (name: string, payload?: unknown) => void
  serialize: () => unknown
  /** Visible solid meshes with world transforms baked (STL/GLB exports). */
  exportSolids?: () => import('three').Object3D | null
  dispose: () => void
}

export type EngineFactory = (ctx: EngineContext) => BuildEngine
