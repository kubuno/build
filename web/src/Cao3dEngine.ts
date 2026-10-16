import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { BaseEngine } from './engineBase'
import type { EngineContext, SelectionInfo, SelField, TimelineItem } from './engine'
import { constrainOrtho, dist, formatLength, len, mmToUnit, sub, unitStep, unitToMm, type Vec2 } from './geometry'
import { uid } from './util'
import {
  dependentsOf, emptyCaoModel, getFeatureProp, isClosedEntity, loadCaoModel, nextName,
  primitiveProps, setFeatureProp, sketchIsClosed, sketchLoops, FEATURE_PROPS,
  type BooleanOp, type CaoModel, type ConstraintKind, type Feature, type FeaturePropSpec,
  type PadFeature, type PrimitiveShape, type SketchEntity, type SketchFeature, type SolidFeature,
} from './cao3dModel'
import { buildEntityLine, entityPoints } from './cao3dGeometry'
import { recompute, type RecomputeResult } from './cao3dRecompute'
import { isSolidFeature } from './cao3dModel'
import { withEdges } from './edges'
import { SketchMode, type SketchHost } from './SketchMode'
import { facePlaneFromHit, isGroundIdentity, planeBasis, toWorld } from './sketchPlane'

interface Mats {
  line: THREE.LineBasicMaterial
  lineSel: THREE.LineBasicMaterial
  lineDim: THREE.LineBasicMaterial     // other sketches, faded (sketch mode)
  body: THREE.MeshPhysicalMaterial
  bodySel: THREE.MeshPhysicalMaterial
  bodyDim: THREE.MeshStandardMaterial  // solids ghosted while editing a sketch
  bodyHover: THREE.MeshPhysicalMaterial
  lineHover: THREE.LineBasicMaterial
  edge: THREE.LineBasicMaterial
  preview: THREE.LineBasicMaterial
  pushFill: THREE.MeshStandardMaterial // translucent push/pull extrusion preview
}

// A live push/pull gesture: dragging a face along the pad's plane normal to
// set its height - either editing an existing pad or padding a ground sketch.
interface PushDrag {
  mode: 'pad' | 'sketch'
  featureId: string          // pad id (mode pad) or sketch id (mode sketch)
  base: number               // height at grab (mm)
  s0: number                 // axis parameter under the cursor at grab
  origin: THREE.Vector3      // point the drag axis passes through
  dir: THREE.Vector3         // drag axis direction (the pad's plane normal)
  height: number             // current height (mm)
}

// CAO3D engine v2 - parametric. The model is a feature timeline (cao3dModel):
// sketches referenced by pads/revolutions/lofts, solids referenced by combines.
// Tools and ribbon commands *append or edit features*; the actual geometry is
// produced by the recompute pipeline (cao3dRecompute + Manifold kernel), and
// this engine only turns runtime results into three.js objects.
export class Cao3dEngine extends BaseEngine<CaoModel> {
  // `declare`: created during super()'s rebuild() (see ArchitectEngine note).
  private declare mats: Mats
  private declare runtime: RecomputeResult
  private previewGroup = new THREE.Group()
  private rectStart: Vec2 | null = null
  private circleCenter: Vec2 | null = null
  private polyPts: Vec2[] = []
  private hover: Vec2 | null = null
  // Move/rotate gizmo (attached to the selected solid) + push/pull state.
  private gizmo!: TransformControls
  private pushDrag: PushDrag | null = null
  private pushPreview: THREE.Mesh | null = null
  private faceRay = new THREE.Raycaster()
  /** Active in-place sketch editor (null = normal modeling mode). */
  private sketchMode: SketchMode | null = null

  constructor(ctx: EngineContext) {
    super(ctx)
    this.h.scene.add(this.previewGroup)

    // Direct-manipulation gizmo for Déplacer / Tourner. It mutates the attached
    // object live; on release we write the transform back to the feature.
    this.gizmo = new TransformControls(this.h.camera, this.h.domElement)
    this.gizmo.size = 0.9
    this.gizmo.translationSnap = ctx.gridStepMm > 0 ? ctx.gridStepMm : null
    this.gizmo.rotationSnap = THREE.MathUtils.degToRad(15)
    this.gizmo.addEventListener('dragging-changed', e => { this.h.controls.enabled = !(e as unknown as { value: boolean }).value })
    this.gizmo.addEventListener('mouseUp', () => this.commitGizmo())
    this.h.scene.add(this.gizmo.getHelper())
    this.syncGizmo()
  }

  protected createEmptyModel(): CaoModel { return emptyCaoModel() }
  protected loadModel(data: unknown): CaoModel { return loadCaoModel(data) }
  protected cloneModel(m: CaoModel): CaoModel { return JSON.parse(JSON.stringify(m)) }
  serialize(): unknown { return this.model }

  private tr(key: string, fallback: string): string {
    return this.ctx.tr ? this.ctx.tr(key, fallback) : fallback
  }

  private ensureMaterials() {
    if (this.mats) return
    const accent = new THREE.Color(this.ctx.accent)
    this.mats = {
      // Sketch lines must read on the light-grey CAO background: a mid blue for
      // idle sketches, the accent for the selected one.
      line: new THREE.LineBasicMaterial({ color: 0x2b6fb0 }),
      lineSel: new THREE.LineBasicMaterial({ color: accent.getHex() }),
      lineDim: new THREE.LineBasicMaterial({ color: 0x2b6fb0, transparent: true, opacity: 0.25 }),
      // Machined-part look à la Fusion: a physical material with a light
      // clearcoat picks up the studio environment and reads as lacquered metal.
      body: new THREE.MeshPhysicalMaterial({
        color: 0xcf8a52, roughness: 0.42, metalness: 0.12,
        clearcoat: 0.55, clearcoatRoughness: 0.28, envMapIntensity: 0.85,
        side: THREE.DoubleSide,
      }),
      bodySel: new THREE.MeshPhysicalMaterial({
        color: 0xcf8a52, roughness: 0.38, metalness: 0.12,
        clearcoat: 0.55, clearcoatRoughness: 0.28, envMapIntensity: 0.85,
        emissive: accent, emissiveIntensity: 0.38,
        side: THREE.DoubleSide,
      }),
      bodyDim: new THREE.MeshStandardMaterial({
        color: 0xcf8a52, transparent: true, opacity: 0.14, depthWrite: false,
        roughness: 0.6, metalness: 0.05,
      }),
      // Hover pre-highlight (select tool): a light lift, less than selection.
      bodyHover: new THREE.MeshPhysicalMaterial({
        color: 0xdd9c66, roughness: 0.4, metalness: 0.12,
        clearcoat: 0.55, clearcoatRoughness: 0.28, envMapIntensity: 0.9,
        emissive: accent, emissiveIntensity: 0.12,
        side: THREE.DoubleSide,
      }),
      lineHover: new THREE.LineBasicMaterial({ color: 0x5b9bd5 }),
      edge: new THREE.LineBasicMaterial({ color: 0x2f3237 }),
      preview: new THREE.LineBasicMaterial({ color: accent }),
      pushFill: new THREE.MeshStandardMaterial({ color: accent.getHex(), transparent: true, opacity: 0.4, roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide }),
    }
  }

  // ---- Model lookup helpers ----------------------------------------------
  private featureById(id: string | null): Feature | null {
    return id ? this.model.features.find(f => f.id === id) ?? null : null
  }

  private sketches(): SketchFeature[] {
    return this.model.features.filter((f): f is SketchFeature => f.type === 'sketch')
  }

  private solidFeatures(): SolidFeature[] {
    return this.model.features.filter(isSolidFeature)
  }

  /** Sketch features still visible (computed and not consumed by a solid). */
  private availableSketches(requireClosed: boolean): SketchFeature[] {
    return this.sketches().filter(s => {
      const rt = this.runtime?.items.get(s.id)
      if (!rt || !rt.computed || rt.consumed) return false
      return !requireClosed || sketchIsClosed(s)
    })
  }

  /** Solid features currently shown (computed, not swallowed by a combine). */
  private availableSolids(): SolidFeature[] {
    return this.solidFeatures().filter(s => {
      const rt = this.runtime?.items.get(s.id)
      return !!rt && rt.computed && !rt.consumed && !rt.error
    })
  }

  /** Insert a new feature at the timeline position: after the rollback tip if
   *  one is set (FreeCAD inserts there), else at the end. Advances the tip. */
  private insertFeature(f: Feature) {
    if (this.model.tip) {
      const i = this.model.features.findIndex(x => x.id === this.model.tip)
      this.model.features.splice(i + 1, 0, f)
      this.model.tip = f.id
    } else {
      this.model.features.push(f)
    }
  }

  // ---- Recompute → scene ---------------------------------------------------
  protected rebuild() {
    this.ensureMaterials()
    // Scene objects are about to be replaced - forget hover material swaps.
    this.hoverSwaps = []
    this.hoverId = null
    this.clearContent()
    this.runtime = recompute(this.model)
    const editing = this.sketchMode?.sketchId ?? null
    for (const f of this.model.features) {
      const rt = this.runtime.items.get(f.id)
      if (!rt || !rt.computed) continue
      if (f.id === editing) continue // drawn by the sketch editor overlay
      if (rt.consumed) continue
      if (f.type === 'sketch') {
        const group = new THREE.Group()
        const mat = editing ? this.mats.lineDim : this.isSel(f.id) ? this.mats.lineSel : this.mats.line
        const basis = isGroundIdentity(f.plane) ? undefined : planeBasis(f.plane)
        for (const e of f.entities) group.add(buildEntityLine(e, mat, 1, basis))
        group.userData.eid = f.id
        this.content.add(group)
      } else if (rt.geometry) {
        // While a sketch is being edited, solids turn into ghosts so the
        // drawing reads clearly - but they still recompute live (a pad follows
        // its sketch as you drag it: the parametric feedback loop).
        const mat = editing ? this.mats.bodyDim : this.isSel(f.id) ? this.mats.bodySel : this.mats.body
        const mesh = new THREE.Mesh(rt.geometry, mat)
        mesh.userData.eid = f.id
        // Manifold outputs are watertight and clean - outline edges work on
        // every solid now, including booleans (impossible with the old CSG).
        const obj = editing ? mesh : withEdges(mesh, this.mats.edge, f.id)
        if (f.pos) obj.position.set(f.pos[0], f.pos[1], f.pos[2])
        if (f.rot) obj.rotation.set(f.rot[0], f.rot[1], f.rot[2])
        this.content.add(obj)
      }
    }
    this.sketchMode?.buildScene()
    this.syncGizmo() // re-attach the gizmo to the freshly-built selected object
    this.emitTimeline()
    if (this.sketchMode) {
      // The properties panel mirrors the sketch selection while editing.
      this.ctx.onSelectionChange(this.sketchMode.hasSelection())
      this.ctx.onSelectionInfo(this.sketchMode.selectionInfo())
    }
  }

  // ---- Sketch editing (in-place, constrained) -------------------------------
  private emitSketchStatus() {
    this.ctx.onSketchStatus?.(this.sketchMode ? { ...this.sketchMode.info } : null)
  }

  private sketchHost(): SketchHost {
    return {
      handle: this.h,
      unit: this.ctx.unit,
      gridStepMm: this.ctx.gridStepMm,
      accent: this.ctx.accent,
      tr: (k, f) => this.tr(k, f),
      snap: v => this.snap(v),
      commit: () => this.committed(),
      refresh: () => this.rebuild(),
      onInfo: () => this.emitSketchStatus(),
    }
  }

  private enterSketch(id: string | null) {
    const f = this.featureById(id ?? this.primarySel())
    if (!f || f.type !== 'sketch' || this.sketchMode) return
    this.select(null)
    this.sketchMode = new SketchMode(this.sketchHost(), f, {
      line: this.mats.line, lineSel: this.mats.lineSel, preview: this.mats.preview,
    })
    this.tool = 'select'
    this.ctx.onToolChange('select')
    this.applyControls()
    this.syncGizmo()
    this.rebuild()
    this.emitSketchStatus()
  }

  private exitSketch() {
    if (!this.sketchMode) return
    this.sketchMode.dispose()
    this.sketchMode = null
    this.tool = 'select'
    this.ctx.onToolChange('select')
    this.clearPreview()
    this.applyControls()
    this.rebuild()
    this.refreshSelection()
    this.emitSketchStatus()
  }

  /** Create an empty sketch feature on `plane` and open it for editing. */
  private newSketch(plane: SketchFeature['plane']) {
    if (this.sketchMode) this.exitSketch()
    const f: SketchFeature = {
      id: uid('f'), type: 'sketch',
      name: nextName(this.model, 'sketch', this.tr('cao_feat_sketch', 'Esquisse')),
      plane, entities: [],
    }
    this.insertFeature(f)
    this.committed()
    this.enterSketch(f.id)
  }

  /** « Nouvelle esquisse » with no explicit plane: arm the plane-pick tool -
   *  clicking a solid face sketches on that face, the grid = the ground. */
  private startPlanePick() {
    if (this.sketchMode) this.exitSketch()
    this.setTool('pickplane')
    this.ctx.onToolChange('pickplane')
  }

  /** Resolve the plane-pick click: face plane (with provenance) or ground. */
  private finishPlanePick(ev: PointerEvent) {
    this.clearFaceHighlight()
    const hit = this.pickFace(ev)
    this.setTool('select')
    this.ctx.onToolChange('select')
    if (hit && hit.face) {
      let o: THREE.Object3D | null = hit.object
      let eid: string | undefined
      while (o && !eid) { eid = o.userData?.eid; o = o.parent }
      const nWorld = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
      this.newSketch(facePlaneFromHit(hit.point, nWorld, eid))
    } else {
      this.newSketch({ kind: 'ground' })
    }
  }

  private emitTimeline() {
    if (!this.ctx.onTimelineChange) return
    const items: TimelineItem[] = this.model.features.map(f => {
      const rt = this.runtime?.items.get(f.id)
      return {
        id: f.id,
        type: f.type,
        name: f.name,
        suppressed: !!f.suppressed,
        consumed: !!rt?.consumed,
        computed: !!rt?.computed,
        error: rt?.error,
        selected: this.isSel(f.id),
        isTip: this.model.tip === f.id,
      }
    })
    this.ctx.onTimelineChange(items)
  }

  // ---- Tool interaction --------------------------------------------------
  /** Pointer coordinates live on the active sketch plane while editing. */
  protected worldAt(ev: PointerEvent | MouseEvent): Vec2 | null {
    return this.sketchMode ? this.sketchMode.worldFromPointer(ev) : super.worldAt(ev)
  }

  protected onSelectDown(world: Vec2, ev: PointerEvent) {
    // Sketch mode: pressing near an endpoint handle starts a solver-resolved drag.
    this.sketchMode?.onToolDown(world, ev)
  }

  /** Two-click tools that rubber-band a rectangle / a circle. */
  private isRectTool(): boolean { return this.tool === 'rect' || this.tool === 'prim.box' }
  private isRoundTool(): boolean {
    return this.tool === 'circle' || (this.tool.startsWith('prim.') && this.tool !== 'prim.box')
  }

  protected onToolDown(world: Vec2, ev: PointerEvent) {
    if (this.sketchMode) { this.sketchMode.onToolDown(world, ev); this.updateSketchPreview(); return }
    if (this.tool === 'pushpull') { this.startPush(world, ev); return }
    const p = this.snap(world)
    if (this.isRectTool()) {
      if (!this.rectStart) { this.rectStart = p } else {
        if (this.tool === 'rect') this.addRect(this.rectStart, p)
        else this.addPrimBox(this.rectStart, p)
        this.rectStart = null
      }
    } else if (this.isRoundTool()) {
      if (!this.circleCenter) { this.circleCenter = p } else {
        const r = dist(this.circleCenter, p)
        if (this.tool === 'circle') this.addCircle(this.circleCenter, r)
        else this.addPrimRound(this.tool.slice(5) as PrimitiveShape, this.circleCenter, r)
        this.circleCenter = null
      }
    } else if (this.tool === 'line') {
      const anchor = this.polyPts.length ? this.polyPts[this.polyPts.length - 1] : null
      this.polyPts.push(anchor ? this.snap(constrainOrtho(anchor, world)) : p)
    }
    this.updatePreview()
  }

  protected onToolMove(world: Vec2 | null, ev: PointerEvent) {
    this.hover = world
    if (this.sketchMode) { this.sketchMode.onToolMove(world, ev); this.updateSketchPreview(); return }
    if (this.pushDrag) { this.updatePush(ev); return }
    if (this.tool === 'pickplane') { this.updateFaceHighlight(ev); return }
    if (this.tool === 'select') { this.updateHoverHighlight(ev); return }
    this.updatePreview()
  }

  // ---- Hover pre-highlight (select tool, FreeCAD-style) --------------------
  private hoverId: string | null = null
  private hoverSwaps: { obj: THREE.Mesh | THREE.Line; mat: THREE.Material }[] = []

  private clearHoverHighlight() {
    for (const { obj, mat } of this.hoverSwaps) obj.material = mat
    this.hoverSwaps = []
    this.hoverId = null
    this.h.domElement.style.cursor = ''
  }

  /** Tint the body/sketch under the pointer so what a click would select is
   *  obvious - material swap only, no recompute/rebuild involved. */
  private updateHoverHighlight(ev: PointerEvent) {
    const id = this.pickedId(ev)
    if (id === this.hoverId) return
    this.clearHoverHighlight()
    this.hoverId = id
    if (!id || this.isSel(id)) return
    const obj = this.findObj(id)
    if (!obj) return
    obj.traverse(o => {
      const m = o as THREE.Mesh
      if ((m as THREE.Mesh).isMesh && m.material === this.mats.body) {
        this.hoverSwaps.push({ obj: m, mat: this.mats.body })
        m.material = this.mats.bodyHover
      } else if ((o as THREE.Line).isLine && (o as THREE.Line).material === this.mats.line) {
        const l = o as THREE.Line
        this.hoverSwaps.push({ obj: l, mat: this.mats.line })
        l.material = this.mats.lineHover
      }
    })
    this.h.domElement.style.cursor = 'pointer'
  }

  // ---- Hover pre-highlight of the face under the pointer (plane picking) ---
  private faceHighlight: THREE.Mesh | null = null

  private clearFaceHighlight() {
    if (!this.faceHighlight) return
    this.previewGroup.remove(this.faceHighlight)
    this.faceHighlight.geometry.dispose()
    ;(this.faceHighlight.material as THREE.Material).dispose()
    this.faceHighlight = null
  }

  /** Highlight the planar region under the pointer: every triangle of the hit
   *  mesh that is coplanar with the hit face (same normal + same plane). */
  private updateFaceHighlight(ev: PointerEvent) {
    this.clearFaceHighlight()
    const hit = this.pickFace(ev)
    if (!hit || !hit.face) return
    const mesh = hit.object as THREE.Mesh
    const geo = mesh.geometry
    const pos = geo.getAttribute('position')
    const index = geo.getIndex()
    if (!index) return
    const n = hit.face.normal // local space
    const pLocal = mesh.worldToLocal(hit.point.clone())
    const planeD = n.dot(pLocal)
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), tn = new THREE.Vector3()
    const out: number[] = []
    for (let i = 0; i < index.count; i += 3) {
      a.fromBufferAttribute(pos, index.getX(i))
      b.fromBufferAttribute(pos, index.getX(i + 1))
      c.fromBufferAttribute(pos, index.getX(i + 2))
      tn.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize()
      if (tn.dot(n) < 0.999) continue
      if (Math.abs(n.dot(a) - planeD) > 0.05) continue
      out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
    }
    if (!out.length) return
    const hgeo = new THREE.BufferGeometry()
    hgeo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3))
    // Blue, not the accent: the accent is orange like the bodies themselves.
    const hmat = new THREE.MeshBasicMaterial({
      color: 0x3b82f6, transparent: true, opacity: 0.4,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide,
    })
    const hl = new THREE.Mesh(hgeo, hmat)
    hl.applyMatrix4(mesh.matrixWorld)
    this.faceHighlight = hl
    this.previewGroup.add(hl)
  }

  protected onToolUp() {
    if (this.sketchMode) { this.sketchMode.onToolUp(); return }
    if (this.pushDrag) this.finishPush()
  }

  // Move/rotate tools keep resolving clicks to a selection so the user can
  // re-target the gizmo without leaving the tool; plane picking is also a
  // click (slop-protected), keeping the camera free to orbit onto a face.
  protected picksInTool(): boolean { return this.tool === 'move' || this.tool === 'rotate' || this.tool === 'pickplane' }
  protected allowsOrbit(): boolean { return this.tool === 'select' || this.tool === 'move' || this.tool === 'rotate' || this.tool === 'pickplane' }

  protected onCommit() {
    if (this.sketchMode) { this.sketchMode.onCommit(); this.updateSketchPreview(); return }
    if (this.tool === 'line' && this.polyPts.length >= 2) {
      this.addSketch({ id: uid('e'), kind: 'poly', pts: this.polyPts.slice(), closed: this.polyPts.length >= 3 })
      this.polyPts = []
    }
    this.resetDrawing()
  }

  protected onCancel() {
    if (this.sketchMode) { this.sketchMode.onCancel(); this.updateSketchPreview(); return }
    this.clearFaceHighlight()
    this.cancelPush(); this.resetDrawing()
  }

  private resetDrawing() {
    this.rectStart = null
    this.circleCenter = null
    this.polyPts = []
    this.clearPreview()
  }

  /** Every drawing gesture lands as its own sketch feature (until the chantier
   *  B sketch editor makes sketches multi-entity with constraints). */
  private addSketch(entity: SketchEntity): SketchFeature {
    const f: SketchFeature = {
      id: uid('f'), type: 'sketch',
      name: nextName(this.model, 'sketch', this.tr('cao_feat_sketch', 'Esquisse')),
      plane: { kind: 'ground' }, entities: [entity],
    }
    this.insertFeature(f)
    this.selection = [f.id]
    this.committed()
    return f
  }

  private addRect(a: Vec2, b: Vec2) {
    if (Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1) return
    this.addSketch({ id: uid('e'), kind: 'rect', a, b })
  }

  private addCircle(c: Vec2, r: number) {
    if (r < 1) return
    this.addSketch({ id: uid('e'), kind: 'circle', c, r })
  }

  // ---- Picking / deletion ------------------------------------------------
  protected onPick(world: Vec2, ev: PointerEvent) {
    if (this.sketchMode) { this.sketchMode.onPick(world, ev); return }
    if (this.tool === 'pickplane') { this.finishPlanePick(ev); return }
    const id = this.pickedId(ev)
    const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey
    if (this.tool === 'move' || this.tool === 'rotate') {
      // Only re-target when a solid was hit; clicking the gizmo or empty space
      // must not drop the current selection.
      const f = this.featureById(id)
      if (f && isSolidFeature(f)) this.select(id, additive)
      return
    }
    this.select(id, additive)
  }

  // ---- Tool switching (keep selection for select/gizmo/pushpull) ---------
  setTool(id: string) {
    if (this.tool === id) return
    this.onCancel()
    this.clearHoverHighlight()
    this.tool = id
    if (this.sketchMode) {
      this.sketchMode.setTool(id)
      this.applyControls()
      return
    }
    // Drawing tools start from a clean slate; select/gizmo/push-pull keep the
    // current selection (the gizmo and push/pull act on it).
    const keepsSelection = id === 'select' || id === 'move' || id === 'rotate' || id === 'pushpull'
    if (!keepsSelection) this.select(null)
    this.applyControls()
    this.syncGizmo()
  }

  protected onViewChanged() {
    if (this.gizmo) this.gizmo.camera = this.h.camera
  }

  // ---- Move / rotate gizmo ----------------------------------------------
  private findObj(eid: string): THREE.Object3D | null {
    return this.content.children.find(o => o.userData?.eid === eid) ?? null
  }

  /** Attach the gizmo to the selected solid when a gizmo tool is active. */
  private syncGizmo() {
    if (!this.gizmo) return
    const active = this.tool === 'move' || this.tool === 'rotate'
    if (!active) { this.gizmo.detach(); return }
    this.gizmo.setMode(this.tool === 'rotate' ? 'rotate' : 'translate')
    const f = this.featureById(this.primarySel())
    const obj = f && isSolidFeature(f) ? this.findObj(f.id) : null
    if (obj) this.gizmo.attach(obj); else this.gizmo.detach()
  }

  /** Write the dragged object's transform back to its feature, then snapshot. */
  private commitGizmo() {
    const obj = this.gizmo.object as THREE.Object3D | undefined
    const eid = obj?.userData?.eid as string | undefined
    const f = this.featureById(eid ?? null)
    if (!obj || !f || !isSolidFeature(f)) return
    f.pos = [obj.position.x, obj.position.y, obj.position.z]
    f.rot = [obj.rotation.x, obj.rotation.y, obj.rotation.z]
    this.committed()
  }

  // ---- Push / pull (mouse extrude) --------------------------------------
  /** Parameter along the axis (origin, unit dir) closest to the pointer ray
   *  (line-line closest point) → the height under the cursor. */
  private axisParam(ev: PointerEvent, origin: THREE.Vector3, dir: THREE.Vector3): number {
    const ray = this.h.screenRay(ev.clientX, ev.clientY)
    const w0 = origin.clone().sub(ray.origin)
    const v = ray.direction // unit
    const b = v.dot(dir)     // u·v
    const d = dir.dot(w0)    // u·w0
    const e = v.dot(w0)      // v·w0
    const denom = 1 - b * b
    if (Math.abs(denom) < 1e-6) return 0
    return (b * e - d) / denom
  }

  /** Raycast the first solid face under the pointer (ignoring outline lines). */
  private pickFace(ev: PointerEvent): THREE.Intersection | null {
    const rect = this.h.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1)
    this.faceRay.setFromCamera(ndc, this.h.camera)
    const hits = this.faceRay.intersectObjects(this.content.children, true)
    return hits.find(h => (h.object as THREE.Mesh).isMesh && !!h.face) ?? null
  }

  private startPush(world: Vec2, ev: PointerEvent) {
    // 1) Grab the cap of an existing pad (the face along its plane normal) →
    //    adjust its height parameter, whatever plane the pad sits on.
    const hit = this.pickFace(ev)
    if (hit && hit.face) {
      let o: THREE.Object3D | null = hit.object
      let eid: string | undefined
      while (o && !eid) { eid = o.userData?.eid; o = o.parent }
      const f = this.featureById(eid ?? null)
      const nWorld = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
      if (f && f.type === 'pad') {
        const sketch = this.featureById(f.sketch)
        const dir = sketch?.type === 'sketch' ? planeBasis(sketch.plane).normal : new THREE.Vector3(0, 1, 0)
        if (nWorld.dot(dir) > 0.6) {
          this.select(f.id)
          this.pushDrag = {
            mode: 'pad', featureId: f.id, base: f.height,
            s0: this.axisParam(ev, hit.point, dir), origin: hit.point.clone(), dir,
            height: f.height,
          }
          return
        }
      }
    }
    // 2) Otherwise, if the click landed inside a visible closed GROUND sketch,
    //    pad it (plane sketches are padded from the ribbon / sketch editor).
    const sketch = this.sketchAt(world)
    if (sketch) {
      const origin = new THREE.Vector3(world.x, 0, world.y)
      const dir = new THREE.Vector3(0, 1, 0)
      this.pushDrag = { mode: 'sketch', featureId: sketch.id, base: 0, s0: this.axisParam(ev, origin, dir), origin, dir, height: 0 }
    }
  }

  private updatePush(ev: PointerEvent) {
    const pd = this.pushDrag
    if (!pd) return
    const step = this.ctx.gridStepMm
    let h = pd.base + (this.axisParam(ev, pd.origin, pd.dir) - pd.s0)
    if (step > 0) h = Math.round(h / step) * step
    h = Math.max(step > 0 ? step : 1, h)
    pd.height = h
    if (pd.mode === 'pad') {
      const f = this.featureById(pd.featureId)
      if (f && f.type === 'pad') { f.height = h; this.rebuild() } // live, snapshot deferred to release
    } else {
      this.updatePushPreview()
    }
  }

  private updatePushPreview() {
    const pd = this.pushDrag
    if (!pd || pd.mode !== 'sketch') return
    this.clearPushPreview()
    const sketch = this.featureById(pd.featureId)
    if (!sketch || sketch.type !== 'sketch' || pd.height <= 0) return
    const entity = sketch.entities.find(isClosedEntity)
    if (!entity) return
    // Cheap three.js preview (no kernel round-trip while dragging).
    const shape = new THREE.Shape()
    const pts = entityPoints(entity)
    shape.moveTo(pts[0].x, -pts[0].y)
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, -pts[i].y)
    shape.closePath()
    const geo = new THREE.ExtrudeGeometry(shape, { depth: pd.height, bevelEnabled: false, steps: 1, curveSegments: 64 })
    geo.rotateX(-Math.PI / 2)
    const mesh = new THREE.Mesh(geo, this.mats.pushFill)
    this.pushPreview = mesh
    this.previewGroup.add(mesh)
  }

  private clearPushPreview() {
    if (!this.pushPreview) return
    this.previewGroup.remove(this.pushPreview)
    this.pushPreview.geometry.dispose()
    this.pushPreview = null
  }

  private finishPush() {
    const pd = this.pushDrag
    this.pushDrag = null
    this.clearPushPreview()
    if (!pd) return
    if (pd.mode === 'pad') {
      // Height already applied live; snapshot only if it actually changed.
      if (pd.height !== pd.base) this.committed()
    } else if (pd.height >= (this.ctx.gridStepMm || 1)) {
      const sketch = this.featureById(pd.featureId)
      if (!sketch || sketch.type !== 'sketch') return
      this.addPad(sketch, pd.height)
    }
  }

  private cancelPush() {
    const pd = this.pushDrag
    if (!pd) return
    this.pushDrag = null
    this.clearPushPreview()
    if (pd.mode === 'pad') {
      const f = this.featureById(pd.featureId)
      if (f && f.type === 'pad') { f.height = pd.base; this.rebuild() }
    }
  }

  /** Topmost visible closed GROUND sketch containing the ground point `w`
   *  (the pointer is resolved on the ground plane outside sketch mode). */
  private sketchAt(w: Vec2): SketchFeature | null {
    const candidates = this.availableSketches(true).filter(s => isGroundIdentity(s.plane))
    for (let i = candidates.length - 1; i >= 0; i--) {
      const entity = candidates[i].entities.find(isClosedEntity)
      if (entity && this.pointInEntity(w, entity)) return candidates[i]
    }
    return null
  }

  private pointInEntity(w: Vec2, e: SketchEntity): boolean {
    if (e.kind === 'rect') {
      const x0 = Math.min(e.a.x, e.b.x), x1 = Math.max(e.a.x, e.b.x)
      const y0 = Math.min(e.a.y, e.b.y), y1 = Math.max(e.a.y, e.b.y)
      return w.x >= x0 && w.x <= x1 && w.y >= y0 && w.y <= y1
    }
    if (e.kind === 'circle') return dist(w, e.c) <= e.r
    if (e.kind !== 'poly') return false
    const pts = e.pts
    let inside = false
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y
      if (((yi > w.y) !== (yj > w.y)) && (w.x < ((xj - xi) * (w.y - yi)) / (yj - yi) + xi)) inside = !inside
    }
    return inside
  }

  // Undo/redo reload the model from a snapshot - the sketch editor must be
  // re-bound to the fresh feature object (or closed if the sketch vanished).
  undo() { super.undo(); this.rebindSketch() }
  redo() { super.redo(); this.rebindSketch() }

  private rebindSketch() {
    if (!this.sketchMode) return
    const f = this.featureById(this.sketchMode.sketchId)
    if (f && f.type === 'sketch') { this.sketchMode.rebind(f); this.rebuild() }
    else this.exitSketch()
  }

  /** Cascade delete: a feature takes its dependents with it (undoable). */
  deleteSelection() {
    if (this.sketchMode) { this.sketchMode.deleteSelection(); return }
    if (!this.selection.length) return
    const doomed = new Set<string>(this.selection)
    for (const id of this.selection) {
      for (const dep of dependentsOf(this.model, id)) doomed.add(dep)
    }
    this.model.features = this.model.features.filter(f => !doomed.has(f.id))
    if (this.model.tip && doomed.has(this.model.tip)) this.model.tip = null
    this.selection = []
    this.committed()
  }

  // ---- Ribbon + timeline commands ----------------------------------------
  protected applyCommand(name: string, payload: unknown) {
    const p = (payload ?? {}) as Record<string, unknown>
    if (name === 'sketch.new') {
      const k = p.plane as 'ground' | 'xy' | 'yz' | undefined
      if (k) this.newSketch({ kind: k })
      else this.startPlanePick()
    }
    else if (name === 'sketch.edit') this.enterSketch((p.id as string) ?? null)
    else if (name === 'sketch.finish') this.exitSketch()
    else if (name === 'sk.constrain') this.sketchMode?.applyConstraint(p.kind as ConstraintKind)
    else if (name === 'sk.dim') this.sketchMode?.applyDimension()
    else if (name === 'extrude') this.extrude(p.height as number | undefined)
    else if (name === 'revolve') this.revolve(p.angle as number | undefined)
    else if (name === 'boolean') this.boolean((p.operation as BooleanOp) ?? 'union')
    else if (name === 'pocket') this.pocket(p.height as number | undefined)
    else if (name === 'groove') this.groove(p.angle as number | undefined)
    else if (name === 'primitive') this.primitive((p.shape as PrimitiveShape) ?? 'box')
    else if (name === 'mirror') this.mirror((p.axis as 'x' | 'z') ?? 'x')
    else if (name === 'pattern') this.pattern((p.mode as 'linear' | 'polar') ?? 'linear')
    else if (name === 'fillet') this.edgeMod('fillet', p.radius as number | undefined)
    else if (name === 'chamfer') this.edgeMod('chamfer', p.radius as number | undefined)
    else if (name === 'loft') this.loft(p.height as number | undefined)
    else if (name === 'setProp') this.setProp(p as { key: string; value: number })
    else if (name === 'feat.select') this.select((p.id as string) ?? null, !!p.additive)
    else if (name === 'feat.rename') this.renameFeature(p.id as string, p.name as string)
    else if (name === 'feat.suppress') this.toggleSuppress(p.id as string)
    else if (name === 'feat.delete') { this.selection = [p.id as string]; this.deleteSelection() }
    else if (name === 'feat.tip') this.setTip((p.id as string | null) ?? null)
    else if (name === 'view.ortho') this.h.setOrtho3d(!!p.on)
  }

  /** Meshes of the visible solids, world transforms baked - export payload. */
  exportSolids(): THREE.Object3D | null {
    this.content.updateMatrixWorld(true)
    const g = new THREE.Group()
    const found: THREE.Mesh[] = []
    this.content.traverse(o => { if ((o as THREE.Mesh).isMesh) found.push(o as THREE.Mesh) })
    for (const mesh of found) {
      const c = new THREE.Mesh(mesh.geometry, new THREE.MeshStandardMaterial({ color: 0xcf8a52 }))
      c.applyMatrix4(mesh.matrixWorld)
      g.add(c)
    }
    g.updateMatrixWorld(true)
    return g.children.length ? g : null
  }

  private renameFeature(id: string, name: string) {
    const f = this.featureById(id)
    const v = (name ?? '').trim()
    if (!f || !v || f.name === v) return
    f.name = v
    this.committed()
  }

  private toggleSuppress(id: string) {
    const f = this.featureById(id)
    if (!f) return
    f.suppressed = !f.suppressed
    if (!f.suppressed) delete f.suppressed
    this.committed()
  }

  /** Rollback: recompute stops at `id` (null = play the whole timeline). */
  private setTip(id: string | null) {
    const next = id && this.featureById(id) ? id : null
    if (this.model.tip === next) return
    this.model.tip = next
    // Drop any selection beyond the new tip (its geometry no longer exists).
    this.committed()
  }

  private selectedSolids(): SolidFeature[] {
    return this.selection
      .map(id => this.featureById(id))
      .filter((f): f is SolidFeature => !!f && isSolidFeature(f))
  }

  private boolean(operation: BooleanOp) {
    // Prefer the explicit selection; otherwise combine the two most recent
    // visible solids.
    let targets = this.selectedSolids()
    if (targets.length < 2) targets = this.availableSolids().slice(-2)
    if (targets.length < 2) return
    const f: Feature = {
      id: uid('f'), type: 'combine',
      name: nextName(this.model, 'combine', this.tr('cao_feat_combine', 'Combinaison')),
      operation, targets: targets.map(t => t.id),
    }
    this.insertFeature(f)
    this.selection = [f.id]
    this.committed()
  }

  private edgeMod(kind: 'fillet' | 'chamfer', radius?: number) {
    const f = this.selectedSolids()[0] ?? this.availableSolids().slice(-1)[0]
    if (!f || f.type !== 'pad') return
    // rect/circle → 3D shells (all edges); poly → 2D corner rounding/bevel of
    // the profile (CrossSection.offset) before extrusion.
    f.edgeMod = { kind, radius: radius && radius > 0 ? radius : 5 }
    this.committed()
  }

  /** Solid a cut feature digs into: the sketch's own face (plane provenance)
   *  when it was drawn on one, otherwise the most recent visible solid. */
  private cutTarget(sketch: SketchFeature): SolidFeature | null {
    if (sketch.plane.kind === 'face' && sketch.plane.feature) {
      const f = this.featureById(sketch.plane.feature)
      const rt = f ? this.runtime?.items.get(f.id) : null
      if (f && isSolidFeature(f) && rt?.computed && !rt.consumed && !rt.error) return f
    }
    const avail = this.availableSolids()
    return avail.length ? avail[avail.length - 1] : null
  }

  private pocket(height?: number) {
    const sketch = this.targetSketch(true)
    const target = sketch ? this.cutTarget(sketch) : null
    if (!sketch || !target) return
    const f: Feature = {
      id: uid('f'), type: 'pocket',
      name: nextName(this.model, 'pocket', this.tr('cao_feat_pocket', 'Poche')),
      sketch: sketch.id, target: target.id,
      height: height && height > 0 ? height : this.model.defaults.extrudeHeight / 2,
    }
    this.insertFeature(f)
    this.selection = [f.id]
    this.committed()
  }

  private groove(angle?: number) {
    const sketch = this.targetSketch(false)
    const target = sketch ? this.cutTarget(sketch) : null
    if (!sketch || !target) return
    const f: Feature = {
      id: uid('f'), type: 'groove',
      name: nextName(this.model, 'groove', this.tr('cao_feat_groove', 'Rainure')),
      sketch: sketch.id, target: target.id,
      angleDeg: angle && angle > 0 ? Math.min(360, angle) : 360,
    }
    this.insertFeature(f)
    this.selection = [f.id]
    this.committed()
  }

  private primitive(shape: PrimitiveShape, dims?: Partial<Feature & { type: 'primitive' }>, pos?: [number, number, number]) {
    const names: Record<PrimitiveShape, [string, string]> = {
      box: ['cao_prim_box', 'Boîte'], cylinder: ['cao_prim_cylinder', 'Cylindre'],
      sphere: ['cao_prim_sphere', 'Sphère'], cone: ['cao_prim_cone', 'Cône'],
      torus: ['cao_prim_torus', 'Tore'],
    }
    const defaults: Partial<Feature & { type: 'primitive' }> =
      shape === 'box' ? { dx: 80, dy: 40, dz: 80 }
      : shape === 'cylinder' ? { r: 30, h: 60 }
      : shape === 'cone' ? { r: 35, h: 70 }
      : shape === 'sphere' ? { r: 35 }
      : { r: 45, r2: 12 }
    const f: Feature = {
      id: uid('f'), type: 'primitive', shape,
      name: nextName(this.model, 'primitive', this.tr(names[shape][0], names[shape][1])),
      ...defaults, ...dims,
      ...(pos ? { pos } : {}),
    }
    this.insertFeature(f)
    this.selection = [f.id]
    this.committed()
  }

  /** Interactive box: two opposite ground corners → footprint at the pointer. */
  private addPrimBox(a: Vec2, b: Vec2) {
    const dx = Math.abs(b.x - a.x), dz = Math.abs(b.y - a.y)
    if (dx < 1 || dz < 1) return
    this.primitive('box', { dx, dz, dy: 40 }, [(a.x + b.x) / 2, 0, (a.y + b.y) / 2])
  }

  /** Interactive round primitives: centre click, then a radius point. */
  private addPrimRound(shape: PrimitiveShape, c: Vec2, r: number) {
    if (r < 1) return
    const dims: Partial<Feature & { type: 'primitive' }> =
      shape === 'cylinder' ? { r, h: 60 }
      : shape === 'cone' ? { r, h: 70 }
      : shape === 'sphere' ? { r }
      : { r, r2: Math.max(2, Math.min(12, r * 0.35)) }
    this.primitive(shape, dims, [c.x, 0, c.y])
  }

  /** Target of mirror/pattern: selected solid, else the most recent visible. */
  private repeatTarget(): SolidFeature | null {
    return this.selectedSolids()[0] ?? this.availableSolids().slice(-1)[0] ?? null
  }

  private mirror(axis: 'x' | 'z') {
    const target = this.repeatTarget()
    if (!target) return
    const f: Feature = {
      id: uid('f'), type: 'mirror',
      name: nextName(this.model, 'mirror', this.tr('cao_feat_mirror', 'Miroir')),
      target: target.id, axis,
    }
    this.insertFeature(f)
    this.selection = [f.id]
    this.committed()
  }

  private pattern(mode: 'linear' | 'polar') {
    const target = this.repeatTarget()
    if (!target) return
    const f: Feature = {
      id: uid('f'), type: 'pattern',
      name: nextName(this.model, 'pattern', this.tr('cao_feat_pattern', 'Répétition')),
      target: target.id, mode,
      count: mode === 'linear' ? 3 : 6,
      ...(mode === 'linear' ? { spacing: 100, axis: 'x' as const } : { angleDeg: 360 }),
    }
    this.insertFeature(f)
    this.selection = [f.id]
    this.committed()
  }

  private targetSketch(requireClosed: boolean): SketchFeature | null {
    const sel = this.featureById(this.primarySel())
    if (sel && sel.type === 'sketch' && (!requireClosed || sketchIsClosed(sel))) return sel
    const avail = this.availableSketches(requireClosed)
    return avail.length ? avail[avail.length - 1] : null
  }

  private addPad(sketch: SketchFeature, height: number, edgeMod?: PadFeature['edgeMod']) {
    const f: PadFeature = {
      id: uid('f'), type: 'pad',
      name: nextName(this.model, 'pad', this.tr('cao_feat_pad', 'Extrusion')),
      sketch: sketch.id, height, edgeMod,
    }
    this.insertFeature(f)
    this.selection = [f.id]
    this.committed()
  }

  private extrude(height?: number) {
    const sketch = this.targetSketch(true)
    if (!sketch) return
    this.addPad(sketch, height && height > 0 ? height : this.model.defaults.extrudeHeight)
  }

  private revolve(angle?: number) {
    const sketch = this.targetSketch(false)
    if (!sketch) return
    const f: Feature = {
      id: uid('f'), type: 'revolve',
      name: nextName(this.model, 'revolve', this.tr('cao_feat_revolve', 'Révolution')),
      sketch: sketch.id,
      angleDeg: angle && angle > 0 ? Math.min(360, angle) : this.model.defaults.revolveAngle,
    }
    this.insertFeature(f)
    this.selection = [f.id]
    this.committed()
  }

  private loft(height?: number) {
    let sketches = this.selection
      .map(id => this.featureById(id))
      .filter((f): f is SketchFeature => !!f && f.type === 'sketch' && sketchIsClosed(f))
    if (sketches.length < 2) sketches = this.availableSketches(true).slice(-2)
    if (sketches.length < 2) return
    const f: Feature = {
      id: uid('f'), type: 'loft',
      name: nextName(this.model, 'loft', this.tr('cao_feat_loft', 'Lissage')),
      sketchA: sketches[0].id, sketchB: sketches[1].id,
      height: height && height > 0 ? height : this.model.defaults.extrudeHeight,
    }
    this.insertFeature(f)
    this.selection = [f.id]
    this.committed()
  }

  private setProp({ key, value }: { key: string; value: number }) {
    if (this.sketchMode) { this.sketchMode.setProp(key, value); return }
    const f = this.featureById(this.primarySel())
    if (!f) return
    const u = this.ctx.unit
    if (f.type === 'sketch') {
      const e = f.entities.find(isClosedEntity) ?? f.entities[0]
      if (!e) return
      const mm = unitToMm(value, u)
      if (e.kind === 'rect') {
        if (key === 'width') e.b = { x: e.a.x + Math.sign(e.b.x - e.a.x || 1) * mm, y: e.b.y }
        else if (key === 'height') e.b = { x: e.b.x, y: e.a.y + Math.sign(e.b.y - e.a.y || 1) * mm }
      } else if (e.kind === 'circle' && key === 'diameter') {
        e.r = mm / 2
      }
      this.committed()
      return
    }
    // Solid features: spec'd parameters (angles/counts raw, lengths convert).
    const raw = key === 'angle' || key === 'pangle' || key === 'count' ? value : unitToMm(value, u)
    if (setFeatureProp(f, key, raw)) this.committed()
  }

  protected selectionInfo(): SelectionInfo | null {
    if (this.sketchMode) return this.sketchMode.selectionInfo()
    const f = this.featureById(this.primarySel())
    if (!f) return null
    const count = this.selection.length
    const u = this.ctx.unit
    const L = (key: string, label: string, mm: number, min = 0): SelField =>
      ({ key, label, value: mmToUnit(mm, u), unit: u, min: mmToUnit(min, u), step: unitStep(u) })
    if (f.type === 'sketch') {
      const e = f.entities.find(isClosedEntity) ?? f.entities[0]
      if (e?.kind === 'rect') return { title: f.name, count, fields: [L('width', this.tr('cao_width', 'Largeur'), Math.abs(e.b.x - e.a.x), 1), L('height', this.tr('cao_height', 'Hauteur'), Math.abs(e.b.y - e.a.y), 1)] }
      if (e?.kind === 'circle') return { title: f.name, count, fields: [L('diameter', this.tr('cao_diameter', 'Diamètre'), e.r * 2, 1)] }
      return { title: f.name, count, fields: [] }
    }
    // Solid features: fields derived from the typed parameter specs (plus the
    // per-shape primitive dimensions and the mode-dependent pattern params).
    let specs: FeaturePropSpec[] = FEATURE_PROPS[f.type]
    if (f.type === 'primitive') specs = primitiveProps(f.shape)
    if (f.type === 'pattern') {
      specs = [...specs, f.mode === 'linear'
        ? { key: 'spacing', labelKey: 'cao_spacing', labelFallback: 'Espacement', kind: 'length', min: 1 }
        : { key: 'pangle', labelKey: 'cao_angle', labelFallback: 'Angle', kind: 'angle', min: 1 }]
    }
    const fields: SelField[] = specs.map(spec => {
      const raw = getFeatureProp(f, spec.key) ?? 0
      const label = this.tr(spec.labelKey, spec.labelFallback)
      if (spec.kind === 'angle') return { key: spec.key, label, value: raw, unit: '°', min: spec.min ?? 0, step: 5 }
      if (spec.kind === 'count') return { key: spec.key, label, value: raw, min: spec.min ?? 2, step: 1 }
      return L(spec.key, label, raw, spec.min ?? 0)
    })
    if (f.type === 'pad' && f.edgeMod) {
      fields.push(L('radius', f.edgeMod.kind === 'fillet' ? this.tr('cao_fillet', 'Congé') : this.tr('cao_chamfer', 'Chanfrein'), f.edgeMod.radius, 0))
    }
    return { title: f.name, count, fields }
  }

  // ---- Preview + labels --------------------------------------------------
  private clearPreview() {
    for (let i = this.previewGroup.children.length - 1; i >= 0; i--) {
      const o = this.previewGroup.children[i] as THREE.Object3D
      if (o === this.pushPreview) continue
      this.previewGroup.remove(o)
      ;(o as THREE.Line).geometry.dispose()
    }
  }

  private line(pts: Vec2[], lift = 2) {
    // Preview coordinates live on the active sketch plane when editing one.
    const basis = this.sketchMode?.basis
    const g = new THREE.BufferGeometry().setFromPoints(
      pts.map(p => basis ? toWorld(basis, p, lift) : new THREE.Vector3(p.x, lift, p.y)))
    this.previewGroup.add(new THREE.Line(g, this.mats.preview))
  }

  private updatePreview() {
    this.clearPreview()
    if (!this.hover) return
    const h = this.snap(this.hover)
    if (this.isRectTool() && this.rectStart) {
      const a = this.rectStart
      this.line([a, { x: h.x, y: a.y }, h, { x: a.x, y: h.y }, a])
    } else if (this.isRoundTool() && this.circleCenter) {
      const r = dist(this.circleCenter, h)
      const pts: Vec2[] = []
      for (let i = 0; i <= 96; i++) { const t = (i / 96) * Math.PI * 2; pts.push({ x: this.circleCenter.x + Math.cos(t) * r, y: this.circleCenter.y + Math.sin(t) * r }) }
      this.line(pts)
    } else if (this.tool === 'line' && this.polyPts.length) {
      const anchor = this.polyPts[this.polyPts.length - 1]
      this.line([...this.polyPts, this.snap(constrainOrtho(anchor, this.hover))])
    }
  }

  private projectVec2(p: Vec2, y = 4) { return this.h.project(new THREE.Vector3(p.x, y, p.y)) }

  /** Rubber-band lines of the sketch editor's active drawing tool. */
  private updateSketchPreview() {
    if (!this.sketchMode) return
    this.clearPreview()
    for (const pts of this.sketchMode.previewPoints()) this.line(pts, 1)
  }

  protected drawLabels() {
    if (!this.mats) return
    if (this.sketchMode) { this.sketchMode.drawLabels(this.labels); return }
    const unit = this.ctx.unit
    if (this.pushDrag) {
      const pd = this.pushDrag
      const at = pd.origin.clone().addScaledVector(pd.dir, pd.height - pd.base + 15)
      this.labels.add(`↥ ${formatLength(pd.height, unit)}`, this.h.project(at), { color: '#fff', bold: true })
      return
    }
    const h = this.hover ? this.snap(this.hover) : null
    if (this.isRectTool() && this.rectStart && h) {
      const a = this.rectStart
      this.labels.add(formatLength(Math.abs(h.x - a.x), unit), this.projectVec2({ x: (a.x + h.x) / 2, y: a.y }), { bold: true })
      this.labels.add(formatLength(Math.abs(h.y - a.y), unit), this.projectVec2({ x: a.x, y: (a.y + h.y) / 2 }), { bold: true })
    } else if (this.isRoundTool() && this.circleCenter && h) {
      const r = dist(this.circleCenter, h)
      this.labels.add(`⌀ ${formatLength(r * 2, unit)}`, this.projectVec2(this.circleCenter), { color: '#fff', bold: true })
    } else if (this.tool === 'line' && this.polyPts.length && h) {
      const anchor = this.polyPts[this.polyPts.length - 1]
      const b = this.snap(constrainOrtho(anchor, this.hover!))
      const mid = { x: (anchor.x + b.x) / 2, y: (anchor.y + b.y) / 2 }
      if (len(sub(b, anchor)) > 1) this.labels.add(formatLength(len(sub(b, anchor)), unit), this.projectVec2(mid), { color: '#fff', bold: true })
    }
    // Selected feature dimension labels.
    const f = this.featureById(this.primarySel())
    if (!f) return
    if (f.type === 'sketch') {
      const e = f.entities.find(isClosedEntity) ?? f.entities[0]
      if (e) this.labelEntity(e)
    } else if ((f.type === 'pad' || f.type === 'revolve')) {
      const sketch = this.featureById(f.sketch)
      const e = sketch?.type === 'sketch' ? (sketch.entities.find(isClosedEntity) ?? sketch.entities[0]) : null
      if (e && sketch?.type === 'sketch') {
        const pts = entityPoints(e)
        const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
        const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
        const txt = f.type === 'revolve' ? `⟳ ${Math.round(f.angleDeg)}°` : `↥ ${formatLength(f.height, unit)}`
        const top = f.type === 'pad' ? f.height : 40
        const at = toWorld(planeBasis(sketch.plane), { x: cx, y: cy }, top + 20)
        this.labels.add(txt, this.h.project(at), { color: '#fff', bold: true })
      }
    }
  }

  private labelEntity(e: SketchEntity) {
    const unit = this.ctx.unit
    if (e.kind === 'rect') {
      this.labels.add(formatLength(Math.abs(e.b.x - e.a.x), unit), this.projectVec2({ x: (e.a.x + e.b.x) / 2, y: e.a.y }), { color: '#fff', bold: true })
      this.labels.add(formatLength(Math.abs(e.b.y - e.a.y), unit), this.projectVec2({ x: e.a.x, y: (e.a.y + e.b.y) / 2 }), { color: '#fff', bold: true })
    } else if (e.kind === 'circle') {
      this.labels.add(`⌀ ${formatLength(e.r * 2, unit)}`, this.projectVec2(e.c), { color: '#fff', bold: true })
    }
  }

  dispose() {
    if (this.sketchMode) { this.sketchMode.dispose(false); this.sketchMode = null }
    if (this.gizmo) {
      this.gizmo.detach()
      this.h.scene.remove(this.gizmo.getHelper())
      this.gizmo.dispose()
    }
    this.h.scene.remove(this.previewGroup)
    this.clearFaceHighlight()
    this.clearPushPreview()
    this.clearPreview()
    if (this.mats) Object.values(this.mats).forEach(m => (m as THREE.Material).dispose())
    if (this.ctx.onTimelineChange) this.ctx.onTimelineChange(null)
    super.dispose()
  }
}
