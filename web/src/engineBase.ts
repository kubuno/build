import * as THREE from 'three'
import type { BuildEngine, EngineContext, SelectionInfo } from './engine'
import type { ViewportHandle } from './Viewport3D'
import { LabelLayer } from './overlay'
import { snapVec, type Vec2 } from './geometry'
import { uid } from './util'

// Shared plumbing for both modeling engines: pointer routing (click vs. drag),
// per-tool camera-control gating, an undo/redo snapshot stack, selection state
// and the dimension-label layer. Subclasses implement the domain model
// (Architect walls / CAO3D sketches): how to load/serialize it, rebuild the
// three.js geometry, draw labels and handle tool interactions.
const CLICK_SLOP = 5 // px of movement below which a pointerup counts as a click

export abstract class BaseEngine<M> implements BuildEngine {
  protected ctx: EngineContext
  protected h: ViewportHandle
  protected labels: LabelLayer
  protected content: THREE.Group
  protected model: M
  protected tool = 'select'
  /** Ordered selection (last = primary). Supports additive shift/ctrl picks. */
  protected selection: string[] = []

  private unregFrame: () => void
  private history: string[] = []
  private histIndex = -1
  private down: { x: number; y: number; button: number } | null = null
  private raycaster = new THREE.Raycaster()
  private ndc = new THREE.Vector2()
  /** Deep-cloned selected entities kept for paste (key = model array they came from). */
  private clipboard: { key: string; obj: Record<string, unknown> }[] = []

  constructor(ctx: EngineContext) {
    this.ctx = ctx
    this.h = ctx.handle
    this.labels = new LabelLayer(this.h.overlay)
    this.content = this.h.content
    this.model = ctx.initialData != null ? this.loadModel(ctx.initialData) : this.createEmptyModel()
    if (this.raycaster.params.Line) this.raycaster.params.Line.threshold = 80

    const el = this.h.domElement
    el.addEventListener('pointerdown', this.handleDown)
    el.addEventListener('pointermove', this.handleMove)
    el.addEventListener('pointerup', this.handleUp)
    el.addEventListener('dblclick', this.handleDblClick)
    el.addEventListener('contextmenu', this.handleContext)
    window.addEventListener('keydown', this.handleKey)

    this.unregFrame = this.h.registerFrame(() => this.frame())
    this.applyControls()
    this.rebuild()
    this.pushHistory(true)
  }

  // ---- Subclass contract -------------------------------------------------
  protected abstract createEmptyModel(): M
  protected abstract loadModel(data: unknown): M
  protected abstract cloneModel(m: M): M
  /** Rebuild all three.js geometry from `this.model` into `this.content`. */
  protected abstract rebuild(): void
  /** Draw dimension/tool labels for the current frame (layer already begun). */
  protected abstract drawLabels(): void
  protected abstract onToolDown(world: Vec2, ev: PointerEvent): void
  protected abstract onToolMove(world: Vec2 | null, ev: PointerEvent): void
  /** Pointer released (left button) while a non-select tool is active — used by
   *  press-drag tools such as push/pull. Default: nothing. */
  protected onToolUp(_world: Vec2 | null, _ev: PointerEvent): void {}
  /** Whether the active (non-select) tool still resolves clicks to a selection
   *  (e.g. the move/rotate gizmo tools). Default: only the select tool picks. */
  protected picksInTool(): boolean { return false }
  protected abstract onPick(world: Vec2, ev: PointerEvent): void
  protected abstract onCommit(): void
  protected abstract onCancel(): void
  protected abstract applyCommand(name: string, payload: unknown): void
  abstract serialize(): unknown

  // ---- Pointer routing ---------------------------------------------------
  /** Pointer → drawing-space coordinates. Default: the ground plane; engines
   *  may override (e.g. the active sketch plane in the CAO3D sketch editor). */
  protected worldAt(ev: PointerEvent | MouseEvent): Vec2 | null {
    return this.h.planePoint(ev.clientX, ev.clientY, 0)
  }

  protected snap(world: Vec2): Vec2 {
    return this.ctx.gridStepMm > 0 ? snapVec(world, this.ctx.gridStepMm) : world
  }

  /** Raycast the content group under the pointer; returns the first hit. */
  protected raycastContent(ev: PointerEvent | MouseEvent): THREE.Intersection | null {
    const rect = this.h.domElement.getBoundingClientRect()
    this.ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.ndc, this.h.camera)
    const hits = this.raycaster.intersectObjects(this.content.children, true)
    return hits[0] ?? null
  }

  /** Walk up to the element id tagged on a picked object (userData.eid). */
  protected pickedId(ev: PointerEvent | MouseEvent): string | null {
    let obj = this.raycastContent(ev)?.object as THREE.Object3D | undefined
    while (obj) {
      const eid = obj.userData?.eid as string | undefined
      if (eid) return eid
      obj = obj.parent ?? undefined
    }
    return null
  }

  private handleDown = (ev: PointerEvent) => {
    this.down = { x: ev.clientX, y: ev.clientY, button: ev.button }
    if (ev.button !== 0) return
    const w = this.worldAt(ev)
    if (!w) return
    if (this.tool !== 'select') this.onToolDown(w, ev)
    else this.onSelectDown(w, ev)
  }

  /** Pointer pressed with the select tool — lets engines start select-mode
   *  drags (sketch endpoint handles…). Default: nothing. */
  protected onSelectDown(_world: Vec2, _ev: PointerEvent): void {}

  private handleMove = (ev: PointerEvent) => {
    this.onToolMove(this.worldAt(ev), ev)
  }

  private handleUp = (ev: PointerEvent) => {
    const d = this.down
    this.down = null
    if (!d || ev.button !== 0) return
    const moved = Math.hypot(ev.clientX - d.x, ev.clientY - d.y)
    if (this.tool === 'select' || this.picksInTool()) {
      if (moved < CLICK_SLOP) { const w = this.worldAt(ev); if (w) this.onPick(w, ev) }
      else this.onToolUp(this.worldAt(ev), ev) // select-mode drag released
    } else {
      this.onToolUp(this.worldAt(ev), ev)
    }
  }

  private handleDblClick = () => { if (this.tool !== 'select') this.onCommit() }
  private handleContext = (ev: MouseEvent) => {
    if (this.tool !== 'select') { ev.preventDefault(); this.onCommit() }
  }
  private handleKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (e.key === 'Escape') { if (this.tool !== 'select') this.onCancel(); else this.select(null) }
    else if (e.key === 'Enter') { if (this.tool !== 'select') this.onCommit() }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection.length) { e.preventDefault(); this.deleteSelection() }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo() }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo() }
  }

  private frame() {
    this.labels.begin()
    this.drawLabels()
    this.labels.end()
  }

  // ---- Camera-control gating --------------------------------------------
  /** Tools that keep the LEFT button on the camera (select + gizmo tools).
   *  Drawing/press-drag tools own the left button — but CAD navigation stays
   *  available on the middle (orbit) and right (pan) buttons. */
  protected allowsOrbit(): boolean { return this.tool === 'select' }

  protected applyControls() {
    const c = this.h.controls
    const orbit = this.allowsOrbit()
    const is3d = this.h.mode === '3d'
    c.enableRotate = is3d
    c.enablePan = true
    c.enableZoom = true
    // OrbitControls ignores buttons mapped to null — the active tool keeps them.
    type Buttons = typeof c.mouseButtons
    c.mouseButtons = {
      LEFT: orbit ? (is3d ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN) : null,
      MIDDLE: is3d ? THREE.MOUSE.ROTATE : THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    } as unknown as Buttons
  }

  // ---- History -----------------------------------------------------------
  protected pushHistory(initial = false) {
    const snap = JSON.stringify(this.serialize())
    if (!initial) this.history = this.history.slice(0, this.histIndex + 1)
    if (this.history[this.histIndex] === snap) return
    this.history.push(snap)
    this.histIndex = this.history.length - 1
    this.notifyHistory()
  }

  /** Call after any model mutation: refresh geometry, mark dirty, snapshot. */
  protected committed() {
    this.rebuild()
    this.refreshSelection()
    this.ctx.onDirty()
    this.pushHistory()
  }

  private notifyHistory() {
    this.ctx.onHistoryChange(this.histIndex > 0, this.histIndex < this.history.length - 1)
  }

  undo() {
    if (this.histIndex <= 0) return
    this.histIndex--
    this.model = this.loadModel(JSON.parse(this.history[this.histIndex]))
    this.select(null); this.rebuild(); this.ctx.onDirty(); this.notifyHistory()
  }

  redo() {
    if (this.histIndex >= this.history.length - 1) return
    this.histIndex++
    this.model = this.loadModel(JSON.parse(this.history[this.histIndex]))
    this.select(null); this.rebuild(); this.ctx.onDirty(); this.notifyHistory()
  }

  // ---- Selection ---------------------------------------------------------
  protected isSel(id: string): boolean { return this.selection.includes(id) }
  protected primarySel(): string | null { return this.selection.length ? this.selection[this.selection.length - 1] : null }

  protected select(id: string | null, additive = false) {
    let next: string[]
    if (id == null) next = []
    else if (additive) next = this.selection.includes(id) ? this.selection.filter(x => x !== id) : [...this.selection, id]
    else next = [id]
    if (next.length === this.selection.length && next.every((v, i) => v === this.selection[i])) return
    this.selection = next
    this.refreshSelection()
    this.rebuild()
  }

  /** Re-emit selection state + structured info (after selection or a dim edit). */
  protected refreshSelection() {
    this.ctx.onSelectionChange(this.selection.length > 0)
    this.ctx.onSelectionInfo(this.selectionInfo())
  }

  /** Subclasses describe the primary selected element for the properties panel. */
  protected selectionInfo(): SelectionInfo | null { return null }

  abstract deleteSelection(): void

  // ---- BuildEngine surface ----------------------------------------------
  setTool(id: string) {
    if (this.tool === id) return
    this.onCancel()
    this.tool = id
    if (id !== 'select') this.select(null)
    this.applyControls()
  }

  setView(mode: '2d' | '3d') {
    this.h.setViewMode(mode)
    this.applyControls()
    this.onViewChanged(mode)
    this.h.fitView() // reframe on the content (no-op if the scene is empty)
  }

  protected onViewChanged(_mode: '2d' | '3d') {}

  fitView() { this.h.fitView() }

  // ---- Clipboard ---------------------------------------------------------
  // Generic, engine-agnostic duplicate-based clipboard. Every model entity
  // lives in a top-level array and carries a string `id`, so copy snapshots the
  // selected entities and paste re-inserts deep clones with fresh ids (refs
  // between copied entities are remapped) and a small planar offset so the
  // duplicates land visibly next to the originals.
  copySelection() {
    if (!this.selection.length) return
    const ids = new Set(this.selection)
    const buf: { key: string; obj: Record<string, unknown> }[] = []
    const m = this.model as unknown as Record<string, unknown>
    for (const key of Object.keys(m)) {
      const arr = m[key]
      if (!Array.isArray(arr)) continue
      for (const el of arr) {
        if (el && typeof el === 'object' && typeof (el as { id?: unknown }).id === 'string'
            && ids.has((el as { id: string }).id)) {
          buf.push({ key, obj: JSON.parse(JSON.stringify(el)) as Record<string, unknown> })
        }
      }
    }
    if (buf.length) this.clipboard = buf
  }

  cutSelection() {
    this.copySelection()
    this.deleteSelection()
  }

  paste() {
    if (!this.clipboard.length) return
    const m = this.model as unknown as Record<string, unknown>
    // Old→new id map so references among the copied entities stay consistent.
    const idMap = new Map<string, string>()
    for (const { obj } of this.clipboard) {
      const oldId = obj.id as string
      idMap.set(oldId, uid(oldId.replace(/[^a-zA-Z].*$/, '') || 'e'))
    }
    const OFFSET = 500 // mm — ~half a metre planar shift, keeps duplicates visible
    const remap = (v: unknown): unknown => {
      if (typeof v === 'string') return idMap.get(v) ?? v
      if (Array.isArray(v)) return v.map(remap)
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>
        const out: Record<string, unknown> = {}
        for (const k of Object.keys(o)) out[k] = remap(o[k])
        // Offset Vec2-like {x, y} nodes (mm coordinates) for visible separation.
        if (typeof o.x === 'number' && typeof o.y === 'number') {
          out.x = (o.x as number) + OFFSET
          out.y = (o.y as number) + OFFSET
        }
        return out
      }
      return v
    }
    const newIds: string[] = []
    for (const { key, obj } of this.clipboard) {
      const clone = remap(obj) as Record<string, unknown>
      const arr = m[key]
      if (Array.isArray(arr)) { arr.push(clone); newIds.push(clone.id as string) }
    }
    if (!newIds.length) return
    this.selection = newIds
    this.committed()
  }

  command(name: string, payload?: unknown) { this.applyCommand(name, payload) }

  dispose() {
    const el = this.h.domElement
    el.removeEventListener('pointerdown', this.handleDown)
    el.removeEventListener('pointermove', this.handleMove)
    el.removeEventListener('pointerup', this.handleUp)
    el.removeEventListener('dblclick', this.handleDblClick)
    el.removeEventListener('contextmenu', this.handleContext)
    window.removeEventListener('keydown', this.handleKey)
    this.unregFrame()
    this.labels.dispose()
    this.clearContent()
  }

  // ---- three.js helpers --------------------------------------------------
  // Dispose only geometries (unique per rebuild). Materials are shared and
  // long-lived, so engines own their lifetime and dispose them in dispose().
  protected clearContent() {
    const c = this.content
    for (let i = c.children.length - 1; i >= 0; i--) {
      const obj = c.children[i]
      c.remove(obj)
      obj.traverse(o => {
        const mesh = o as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
      })
    }
  }
}
