import * as THREE from 'three'
import type { Vec2 } from './geometry'
import { dist, formatLength, mmToUnit, unitStep, unitToMm } from './geometry'
import { uid } from './util'
import {
  arcPoints, type ConstraintKind, type ConstraintRef, type SketchConstraint,
  type SketchEntity, type SketchFeature,
} from './cao3dModel'
import { solveSketch, type DragTarget } from './sketchSolver'
import { intersectRay, isGroundIdentity, planeBasis, toWorld, type PlaneBasis } from './sketchPlane'
import { buildEntityLine } from './cao3dGeometry'
import type { SelectionInfo, SelField } from './engine'
import type { LabelLayer } from './overlay'
import type { ViewportHandle } from './Viewport3D'
import type { Unit } from './types'

// In-place sketch editing (FreeCAD Sketcher / Fusion « Modifier l'esquisse »):
// the camera locks face-on to the sketch plane, solids dim out, and the sketch
// becomes a live constrained drawing — every mutation goes through planegcs,
// endpoints become draggable handles resolved in real time, and the remaining
// degrees of freedom are reported to the status chip. The engine delegates all
// pointer/tool/selection handling here while a sketch is open.

/** What the engine must expose to the sketch editor. */
export interface SketchHost {
  handle: ViewportHandle
  unit: Unit
  gridStepMm: number
  accent: string
  tr(key: string, fallback: string): string
  snap(v: Vec2): Vec2
  /** Model mutated → rebuild + dirty + undo snapshot. */
  commit(): void
  /** Geometry-only refresh (live drag: no snapshot). */
  refresh(): void
  /** Solver diagnostics changed (DoF / conflicts chip). */
  onInfo(): void
}

export interface SketchInfo {
  dof: number
  conflicting: number
  solved: boolean
}

const PICK_PX = 12 // screen-space grab radius for endpoint handles

type Role = NonNullable<ConstraintRef['point']>

/** Named points of an entity (role + current position). */
function entityHandles(e: SketchEntity): { role: Role; p: Vec2 }[] {
  switch (e.kind) {
    case 'point': return [{ role: 'p', p: e.p }]
    case 'segment': return [{ role: 'a', p: e.a }, { role: 'b', p: e.b }]
    case 'circle': return [{ role: 'center', p: e.c }]
    case 'arc': return [
      { role: 'center', p: e.c },
      { role: 'start', p: { x: e.c.x + Math.cos(e.a0) * e.r, y: e.c.y + Math.sin(e.a0) * e.r } },
      { role: 'end', p: { x: e.c.x + Math.cos(e.a1) * e.r, y: e.c.y + Math.sin(e.a1) * e.r } },
    ]
    default: return []
  }
}

export class SketchMode {
  readonly sketchId: string
  /** World basis of the sketch plane (used by the engine for previews too). */
  readonly basis: PlaneBasis
  tool = 'select'
  info: SketchInfo = { dof: 0, conflicting: 0, solved: true }
  /** Typed selection: entities and/or specific points. Last = primary. */
  private refs: ConstraintRef[] = []
  private group = new THREE.Group()
  private handlePoints: THREE.Points | null = null
  private raycaster = new THREE.Raycaster()
  // Drawing state
  private segChain: Vec2 | null = null // last committed point of the segment chain
  private circleCenter: Vec2 | null = null
  private arcPts: Vec2[] = [] // center, start (waiting for end)
  private rectStart: Vec2 | null = null
  private hover: Vec2 | null = null
  // Drag state (select tool, endpoint handles)
  private drag: { ref: ConstraintRef; moved: boolean } | null = null
  private savedView: '2d' | '3d'

  constructor(
    private host: SketchHost,
    private sketch: SketchFeature,
    private mats: { line: THREE.LineBasicMaterial; lineSel: THREE.LineBasicMaterial; preview: THREE.LineBasicMaterial },
  ) {
    this.sketchId = sketch.id
    this.basis = planeBasis(sketch.plane)
    this.savedView = host.handle.mode
    host.handle.scene.add(this.group)
    if (this.raycaster.params.Line) this.raycaster.params.Line.threshold = 6
    if (isGroundIdentity(sketch.plane)) {
      host.handle.setViewMode('2d')
      host.handle.fitView()
    } else {
      // Face-on view of the plane; camera up = -planeY matches the legacy
      // top-down orientation (sketch +y goes down-screen, like the ground).
      this.host.handle.setPlaneView(this.basis.origin, this.basis.normal, this.basis.y.clone().negate())
    }
    this.resolve(false)
  }

  /** Pointer → sketch-plane coordinates (ray ∩ plane). */
  worldFromPointer(ev: PointerEvent | MouseEvent): Vec2 | null {
    return intersectRay(this.basis, this.host.handle.screenRay(ev.clientX, ev.clientY))
  }

  /** Point at the fresh feature object after an undo/redo snapshot reload. */
  rebind(sketch: SketchFeature) {
    this.sketch = sketch
    this.refs = this.refs.filter(r => sketch.entities.some(e => e.id === r.entity))
    this.resolve(false)
  }

  dispose(restoreView = true) {
    this.clearGroup()
    this.host.handle.scene.remove(this.group)
    if (restoreView) {
      // Always restore through setViewMode: it also brings grid/ground/axes
      // back after a face-on plane view.
      this.host.handle.setViewMode(this.savedView)
      this.host.handle.fitView()
    }
  }

  // ---- Solver round-trip ---------------------------------------------------
  /** Solve the sketch, write the solution back, update diagnostics. */
  private resolve(commitAfter: boolean, drag?: DragTarget): boolean {
    let out
    try {
      out = solveSketch(this.sketch, drag)
    } catch {
      this.info = { dof: 0, conflicting: 0, solved: false }
      this.host.onInfo()
      return false
    }
    this.info = { dof: Math.max(0, out.dof), conflicting: out.conflicting.length, solved: out.ok }
    if (out.ok) this.sketch.entities = out.entities
    this.host.onInfo()
    if (commitAfter) this.host.commit()
    else this.host.refresh()
    return out.ok
  }

  // ---- Scene ----------------------------------------------------------------
  /** Rebuild the sketch-editing visuals (called from the engine's rebuild). */
  buildScene() {
    this.clearGroup()
    const selected = new Set(this.refs.map(r => r.entity))
    for (const e of this.sketch.entities) {
      const line = buildEntityLine(e, selected.has(e.id) ? this.mats.lineSel : this.mats.line, 0.5, this.basis)
      this.group.add(line)
    }
    // Endpoint handles as a single Points cloud (screen-constant size).
    const pos: number[] = []
    const push = (v: Vec2) => { const w = toWorld(this.basis, v, 1); pos.push(w.x, w.y, w.z) }
    for (const e of this.sketch.entities) {
      for (const h of entityHandles(e)) push(h.p)
    }
    // Origin marker (the solver's fixed anchor).
    push({ x: 0, y: 0 })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    const mat = new THREE.PointsMaterial({
      color: new THREE.Color(this.host.accent), size: 7, sizeAttenuation: false,
      depthTest: false,
    })
    this.handlePoints = new THREE.Points(geo, mat)
    this.handlePoints.renderOrder = 10
    this.group.add(this.handlePoints)
  }

  private clearGroup() {
    for (let i = this.group.children.length - 1; i >= 0; i--) {
      const o = this.group.children[i] as THREE.Object3D
      this.group.remove(o)
      const line = o as THREE.Line
      line.geometry?.dispose()
      if (o === (this.handlePoints as THREE.Object3D | null)) (line.material as THREE.Material).dispose()
    }
    this.handlePoints = null
  }

  // ---- Picking ---------------------------------------------------------------
  /** Nearest entity handle within PICK_PX of the pointer, if any. */
  private pickHandle(ev: PointerEvent): ConstraintRef | null {
    const h = this.host.handle
    let best: { ref: ConstraintRef; d: number } | null = null
    for (const e of this.sketch.entities) {
      for (const hd of entityHandles(e)) {
        const sp = h.project(toWorld(this.basis, hd.p, 1))
        if (!sp.visible) continue
        const rect = h.domElement.getBoundingClientRect()
        const d = Math.hypot(sp.x - (ev.clientX - rect.left), sp.y - (ev.clientY - rect.top))
        if (d <= PICK_PX && (!best || d < best.d)) best = { ref: { entity: e.id, point: hd.role }, d }
      }
    }
    return best?.ref ?? null
  }

  /** Entity line under the pointer (raycast on this group's lines). */
  private pickEntity(ev: PointerEvent): string | null {
    const h = this.host.handle
    const rect = h.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(ndc, h.camera)
    const hits = this.raycaster.intersectObjects(this.group.children, false)
    for (const hit of hits) {
      const eid = hit.object.userData?.eid as string | undefined
      if (eid) return eid
    }
    return null
  }

  // ---- Pointer routing (delegated from the engine) ----------------------------
  onToolDown(world: Vec2, ev: PointerEvent) {
    const p = this.host.snap(world)
    switch (this.tool) {
      case 'select': {
        const handle = this.pickHandle(ev)
        if (handle) { this.drag = { ref: handle, moved: false }; return }
        break
      }
      case 'sk.segment': {
        if (this.segChain) this.addSegment(this.segChain, p)
        this.segChain = p
        break
      }
      case 'sk.circle':
        if (!this.circleCenter) { this.circleCenter = p } else {
          this.addEntity({ id: uid('e'), kind: 'circle', c: this.circleCenter, r: Math.max(1, dist(this.circleCenter, p)) })
          this.circleCenter = null
        }
        break
      case 'sk.arc': {
        this.arcPts.push(p)
        if (this.arcPts.length === 3) {
          const [c, s, e] = this.arcPts
          const r = Math.max(1, dist(c, s))
          const a0 = Math.atan2(s.y - c.y, s.x - c.x)
          const a1 = Math.atan2(e.y - c.y, e.x - c.x)
          this.addEntity({ id: uid('e'), kind: 'arc', c, r, a0, a1 })
          this.arcPts = []
        }
        break
      }
      case 'sk.point':
        this.addEntity({ id: uid('e'), kind: 'point', p })
        break
      case 'sk.rect':
        if (!this.rectStart) { this.rectStart = p } else { this.addConstrainedRect(this.rectStart, p); this.rectStart = null }
        break
    }
  }

  onToolMove(world: Vec2 | null, ev: PointerEvent) {
    this.hover = world
    if (this.drag && world) {
      this.drag.moved = true
      const t = this.host.snap(world)
      this.resolve(false, { entity: this.drag.ref.entity, point: (this.drag.ref.point ?? 'p') as DragTarget['point'], x: t.x, y: t.y })
      return
    }
    void ev
  }

  onToolUp() {
    if (this.drag) {
      const moved = this.drag.moved
      this.drag = null
      if (moved) {
        this.host.commit() // snapshot the final dragged position
        this.resolve(false) // re-solve unpinned → correct DoF on the chip
      }
    }
  }

  onPick(_world: Vec2, ev: PointerEvent) {
    const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey
    const ref = this.pickHandle(ev) ?? (() => {
      const eid = this.pickEntity(ev)
      return eid ? { entity: eid } : null
    })()
    if (!ref) { if (!additive) this.refs = [] }
    else if (additive) {
      const key = (r: ConstraintRef) => `${r.entity}:${r.point ?? ''}`
      this.refs = this.refs.some(r => key(r) === key(ref))
        ? this.refs.filter(r => key(r) !== key(ref))
        : [...this.refs, ref]
    } else {
      this.refs = [ref]
    }
    this.host.refresh()
  }

  onCommit() { this.segChain = null; this.circleCenter = null; this.arcPts = []; this.rectStart = null }
  onCancel() { this.onCommit(); this.drag = null }

  setTool(id: string) {
    this.onCancel()
    this.tool = id
    if (id !== 'select') { this.refs = []; this.host.refresh() }
  }

  // ---- Entity / constraint creation -------------------------------------------
  private addEntity(e: SketchEntity) {
    this.sketch.entities.push(e)
    this.resolve(true)
  }

  /** Chained segments: consecutive ends are welded with coincident constraints. */
  private addSegment(a: Vec2, b: Vec2) {
    if (dist(a, b) < 0.5) return
    const seg: SketchEntity = { id: uid('e'), kind: 'segment', a, b }
    const prev = this.sketch.entities[this.sketch.entities.length - 1]
    this.sketch.entities.push(seg)
    if (prev?.kind === 'segment' && dist(prev.b, a) < 0.5) {
      this.addConstraintRaw('coincident', [{ entity: prev.id, point: 'b' }, { entity: seg.id, point: 'a' }])
    }
    this.resolve(true)
  }

  /** Rectangle as 4 segments + coincident corners + horizontal/vertical — the
   *  canonical constrained rectangle (FreeCAD's rectangle tool). */
  private addConstrainedRect(p0: Vec2, p1: Vec2) {
    if (Math.abs(p0.x - p1.x) < 1 || Math.abs(p0.y - p1.y) < 1) return
    const A = { x: p0.x, y: p0.y }, B = { x: p1.x, y: p0.y }, C = { x: p1.x, y: p1.y }, D = { x: p0.x, y: p1.y }
    const s = (a: Vec2, b: Vec2): SketchEntity => ({ id: uid('e'), kind: 'segment', a, b })
    const [ab, bc, cd, da] = [s(A, B), s(B, C), s(C, D), s(D, A)]
    this.sketch.entities.push(ab, bc, cd, da)
    const cc = (e1: SketchEntity, e2: SketchEntity) =>
      this.addConstraintRaw('coincident', [{ entity: e1.id, point: 'b' }, { entity: e2.id, point: 'a' }])
    cc(ab, bc); cc(bc, cd); cc(cd, da); cc(da, ab)
    this.addConstraintRaw('horizontal', [{ entity: ab.id }])
    this.addConstraintRaw('horizontal', [{ entity: cd.id }])
    this.addConstraintRaw('vertical', [{ entity: bc.id }])
    this.addConstraintRaw('vertical', [{ entity: da.id }])
    this.resolve(true)
  }

  private addConstraintRaw(kind: ConstraintKind, refs: ConstraintRef[], value?: number) {
    const c: SketchConstraint = { id: uid('c'), kind, refs, value }
    if (!this.sketch.constraints) this.sketch.constraints = []
    this.sketch.constraints.push(c)
    return c
  }

  /** Ribbon constraint button applied to the current selection. Returns false
   *  when the selection doesn't fit the constraint (button stays no-op). */
  applyConstraint(kind: ConstraintKind): boolean {
    const refs = this.refs
    const ent = (i: number) => this.sketch.entities.find(e => e.id === refs[i]?.entity) ?? null
    const isPointRef = (r?: ConstraintRef) => {
      if (!r) return false
      const e = this.sketch.entities.find(x => x.id === r.entity)
      return !!e && (e.kind === 'point' || r.point != null)
    }
    let ok = false
    switch (kind) {
      case 'coincident': ok = refs.length === 2 && isPointRef(refs[0]) && isPointRef(refs[1]); break
      case 'horizontal': case 'vertical':
        ok = (refs.length === 1 && ent(0)?.kind === 'segment')
          || (refs.length === 2 && isPointRef(refs[0]) && isPointRef(refs[1]))
        break
      case 'parallel': case 'perpendicular': case 'equal':
        ok = refs.length === 2 && ent(0)?.kind === 'segment' && ent(1)?.kind === 'segment'
        break
      case 'tangent': {
        const kinds = [ent(0)?.kind, ent(1)?.kind]
        ok = refs.length === 2 && kinds.every(k => k === 'segment' || k === 'circle' || k === 'arc')
          && kinds.some(k => k === 'circle' || k === 'arc')
        break
      }
      case 'pointOn':
        ok = refs.length === 2 && isPointRef(refs[0])
          && ['segment', 'circle', 'arc'].includes(ent(1)?.kind ?? '')
        break
      default: return false
    }
    if (!ok) return false
    const c = this.addConstraintRaw(kind, refs.map(r => ({ ...r })))
    if (!this.resolve(true)) {
      // Unsolvable → drop the constraint again (kept simple; the chip flashed red).
      this.sketch.constraints = this.sketch.constraints!.filter(x => x.id !== c.id)
      this.resolve(true)
      return false
    }
    return true
  }

  /** Ribbon « Cote » button: dimension the current selection at its measured
   *  value (length of a segment, radius, distance between points, angle). */
  applyDimension(): boolean {
    const refs = this.refs
    const ent = (i: number) => this.sketch.entities.find(e => e.id === refs[i]?.entity) ?? null
    const e0 = ent(0), e1 = ent(1)
    if (refs.length === 1 && e0?.kind === 'segment') {
      this.upsertDim('distance', [{ entity: e0.id }], dist(e0.a, e0.b))
      return true
    }
    if (refs.length === 1 && (e0?.kind === 'circle' || e0?.kind === 'arc')) {
      this.upsertDim('radius', [{ entity: e0.id }], e0.r)
      return true
    }
    if (refs.length === 2 && refs[0].point && refs[1].point && e0 && e1) {
      const pa = entityHandles(e0).find(h => h.role === refs[0].point)?.p
      const pb = entityHandles(e1).find(h => h.role === refs[1].point)?.p
      if (pa && pb) { this.upsertDim('distance', refs.map(r => ({ ...r })), dist(pa, pb)); return true }
    }
    if (refs.length === 2 && e0?.kind === 'segment' && e1?.kind === 'segment') {
      const ang = (e: { a: Vec2; b: Vec2 }) => Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x)
      let deg = ((ang(e1) - ang(e0)) * 180) / Math.PI
      deg = ((deg % 180) + 180) % 180
      this.upsertDim('angle', refs.map(r => ({ ...r })), Math.round(deg * 10) / 10)
      return true
    }
    return false
  }

  /** One driving dimension per (kind, ref-set): update it if it exists. */
  private upsertDim(kind: ConstraintKind, refs: ConstraintRef[], value: number) {
    const key = (rs: ConstraintRef[]) => rs.map(r => `${r.entity}:${r.point ?? ''}`).sort().join('|')
    const existing = (this.sketch.constraints ?? [])
      .find(c => c.kind === kind && key(c.refs) === key(refs))
    if (existing) existing.value = value
    else this.addConstraintRaw(kind, refs, value)
    this.resolve(true)
  }

  // ---- Selection info / property edits (engine delegates when active) ----------
  selectionInfo(): SelectionInfo | null {
    const prim = this.refs[this.refs.length - 1]
    if (!prim) return null
    const e = this.sketch.entities.find(x => x.id === prim.entity)
    if (!e) return null
    const u = this.host.unit
    const L = (key: string, label: string, mm: number): SelField =>
      ({ key, label, value: mmToUnit(mm, u), unit: u, min: 0, step: unitStep(u) })
    const fields: SelField[] = []
    if (e.kind === 'segment') fields.push(L('sk.len', this.host.tr('sk_length', 'Longueur'), dist(e.a, e.b)))
    if (e.kind === 'circle' || e.kind === 'arc') fields.push(L('sk.rad', this.host.tr('cao_radius', 'Rayon'), e.r))
    const names: Record<string, string> = {
      point: this.host.tr('sk_point', 'Point'), segment: this.host.tr('sk_segment', 'Ligne'),
      circle: this.host.tr('cao_circle', 'Cercle'), arc: this.host.tr('sk_arc', 'Arc'),
      rect: this.host.tr('cao_rect', 'Rectangle'), poly: this.host.tr('cao_poly', 'Polyligne'),
    }
    return { title: names[e.kind] ?? e.kind, count: this.refs.length, fields }
  }

  /** Property edit: creates/updates the corresponding driving dimension. */
  setProp(key: string, value: number): boolean {
    const prim = this.refs[this.refs.length - 1]
    const e = prim ? this.sketch.entities.find(x => x.id === prim.entity) : null
    if (!e) return false
    const mm = unitToMm(value, this.host.unit)
    if (key === 'sk.len' && e.kind === 'segment') { this.upsertDim('distance', [{ entity: e.id }], Math.max(0.1, mm)); return true }
    if (key === 'sk.rad' && (e.kind === 'circle' || e.kind === 'arc')) { this.upsertDim('radius', [{ entity: e.id }], Math.max(0.1, mm)); return true }
    return false
  }

  /** Delete selected entities (with their constraints). */
  deleteSelection(): boolean {
    if (!this.refs.length) return false
    const ids = new Set(this.refs.map(r => r.entity))
    this.sketch.entities = this.sketch.entities.filter(e => !ids.has(e.id))
    if (this.sketch.constraints) {
      this.sketch.constraints = this.sketch.constraints.filter(c => c.refs.every(r => !ids.has(r.entity)))
      if (!this.sketch.constraints.length) delete this.sketch.constraints
    }
    this.refs = []
    this.resolve(true)
    return true
  }

  hasSelection(): boolean { return this.refs.length > 0 }

  // ---- Labels -------------------------------------------------------------------
  drawLabels(labels: LabelLayer) {
    const h = this.host.handle
    const u = this.host.unit
    const project = (p: Vec2, lift = 2) => h.project(toWorld(this.basis, p, lift))
    // Driving dimensions.
    for (const c of this.sketch.constraints ?? []) {
      if (c.kind !== 'distance' && c.kind !== 'radius' && c.kind !== 'angle') continue
      const e0 = this.sketch.entities.find(e => e.id === c.refs[0]?.entity)
      if (!e0) continue
      let anchor: Vec2 | null = null
      let text = ''
      if (c.kind === 'radius' && (e0.kind === 'circle' || e0.kind === 'arc')) {
        anchor = e0.kind === 'circle' ? e0.c : arcPoints(e0, 2)[1]
        text = `R ${formatLength(c.value ?? e0.r, u)}`
      } else if (c.kind === 'distance' && e0.kind === 'segment' && c.refs.length === 1) {
        anchor = { x: (e0.a.x + e0.b.x) / 2, y: (e0.a.y + e0.b.y) / 2 }
        text = formatLength(c.value ?? 0, u)
      } else if (c.kind === 'distance' && c.refs.length === 2) {
        const pa = entityHandles(e0).find(hd => hd.role === c.refs[0].point)?.p
        const e1 = this.sketch.entities.find(e => e.id === c.refs[1]?.entity)
        const pb = e1 ? entityHandles(e1).find(hd => hd.role === c.refs[1].point)?.p : null
        if (pa && pb) { anchor = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }; text = formatLength(c.value ?? 0, u) }
      } else if (c.kind === 'angle' && e0.kind === 'segment') {
        anchor = e0.b
        text = `${c.value ?? 0}°`
      }
      if (anchor) labels.add(text, project(anchor), { background: 'rgba(43,111,176,0.85)', color: '#fff', bold: true })
    }
    // Drawing previews (rubber lines are drawn by the engine's preview group —
    // here we only surface the live numbers).
    if (this.tool === 'sk.segment' && this.segChain && this.hover) {
      const t = this.host.snap(this.hover)
      labels.add(formatLength(dist(this.segChain, t), u), project({ x: (this.segChain.x + t.x) / 2, y: (this.segChain.y + t.y) / 2 }), { color: '#fff', bold: true })
    } else if (this.tool === 'sk.circle' && this.circleCenter && this.hover) {
      labels.add(`R ${formatLength(dist(this.circleCenter, this.host.snap(this.hover)), u)}`, project(this.circleCenter), { color: '#fff', bold: true })
    }
  }

  /** Rubber-band preview points for the active drawing tool (engine draws them). */
  previewPoints(): Vec2[][] {
    if (!this.hover) return []
    const t = this.host.snap(this.hover)
    if (this.tool === 'sk.segment' && this.segChain) return [[this.segChain, t]]
    if (this.tool === 'sk.rect' && this.rectStart) {
      const a = this.rectStart
      return [[a, { x: t.x, y: a.y }, t, { x: a.x, y: t.y }, a]]
    }
    if (this.tool === 'sk.circle' && this.circleCenter) {
      const r = dist(this.circleCenter, t)
      const pts: Vec2[] = []
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2
        pts.push({ x: this.circleCenter.x + Math.cos(a) * r, y: this.circleCenter.y + Math.sin(a) * r })
      }
      return [pts]
    }
    if (this.tool === 'sk.arc' && this.arcPts.length) {
      if (this.arcPts.length === 1) return [[this.arcPts[0], t]]
      const [c, s] = this.arcPts
      const r = dist(c, s)
      const a0 = Math.atan2(s.y - c.y, s.x - c.x)
      const a1 = Math.atan2(t.y - c.y, t.x - c.x)
      return [arcPoints({ c, r, a0, a1 }, 48).map(p => p)].map(x => x)
    }
    return []
  }
}
