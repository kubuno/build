import * as THREE from 'three'
import { BaseEngine } from './engineBase'
import type { EngineContext } from './engine'
import {
  closestOnSegment, constrainOrtho, dist, formatArea, formatLength, len,
  polygonArea, sub, type Vec2,
} from './geometry'
import { uid } from './util'
import {
  emptyArchModel, loadArchModel, type ArchModel, type ArchOpening, type OpeningKind,
} from './architectModel'
import { buildBridge, buildBuilding, buildOpeningPanel, buildRoad, buildRoof, buildSlab, buildWall } from './architectGeometry'
import { withEdges } from './edges'
import { defaultCityOptions, generateCity, makeBuilding, rectPoly } from './procedural'
import type { ArchBridge, ArchRoof, BuildingStyle, RoofType } from './architectModel'
import { mmToUnit, unitToMm, unitStep } from './geometry'
import type { SelectionInfo, SelField } from './engine'

interface Mats {
  wall: THREE.MeshStandardMaterial
  wallSel: THREE.MeshStandardMaterial
  slab: THREE.MeshStandardMaterial
  slabSel: THREE.MeshStandardMaterial
  road: THREE.MeshStandardMaterial
  roadSel: THREE.MeshStandardMaterial
  door: THREE.MeshStandardMaterial
  doorSel: THREE.MeshStandardMaterial
  glass: THREE.MeshStandardMaterial
  glassSel: THREE.MeshStandardMaterial
  roof: THREE.MeshStandardMaterial
  roofSel: THREE.MeshStandardMaterial
  core: THREE.MeshStandardMaterial   // building spandrel/mullion
  parapet: THREE.MeshStandardMaterial
  mech: THREE.MeshStandardMaterial   // rooftop plant
  deck: THREE.MeshStandardMaterial   // bridge road
  stone: THREE.MeshStandardMaterial  // bridge masonry
  rail: THREE.MeshStandardMaterial   // bridge parapet
  edge: THREE.LineBasicMaterial
  edgeSel: THREE.LineBasicMaterial
  preview: THREE.LineBasicMaterial
}

// Architect modeling engine: draw walls/rooms/openings/roads on the metric grid
// as a 2D plan, toggle to a 3D elevation of the very same geometry. Openings cut
// real gaps in the walls (pillars + header + sill) and carry a visible leaf/pane.
export class ArchitectEngine extends BaseEngine<ArchModel> {
  // `declare`: materials are created during super()'s rebuild(); a plain field
  // would be re-defined to undefined after super() under useDefineForClassFields.
  private declare mats: Mats
  private declare glassPalette: THREE.MeshStandardMaterial[]
  private previewGroup = new THREE.Group()
  private lastPoint: Vec2 | null = null // wall/road chain anchor
  private roomStart: Vec2 | null = null
  private hover: Vec2 | null = null

  constructor(ctx: EngineContext) {
    super(ctx)
    this.h.scene.add(this.previewGroup)
  }

  protected createEmptyModel(): ArchModel { return emptyArchModel() }
  protected loadModel(data: unknown): ArchModel { return loadArchModel(data) }
  protected cloneModel(m: ArchModel): ArchModel { return JSON.parse(JSON.stringify(m)) }
  serialize(): unknown { return this.model }

  private ensureMaterials() {
    if (this.mats) return
    const accent = new THREE.Color(this.ctx.accent)
    const std = (color: number, opts: THREE.MeshStandardMaterialParameters = {}) =>
      new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, ...opts })
    const sel = (color: number, opts: THREE.MeshStandardMaterialParameters = {}) =>
      std(color, { emissive: accent, emissiveIntensity: 0.55, ...opts })
    // Tuned for the light-grey Architect background: bright white walls, a soft
    // grey floor slab, dark asphalt roads - all defined by the dark edge lines.
    this.mats = {
      wall: std(0xffffff), wallSel: sel(0xffffff),
      slab: std(0xc2c8d0), slabSel: sel(0xc2c8d0),
      road: std(0x3a3f45), roadSel: sel(0x3a3f45),
      door: std(0x9c6b3f), doorSel: sel(0x9c6b3f),
      glass: std(0x6fb3d9, { transparent: true, opacity: 0.4 }), glassSel: sel(0x6fb3d9, { transparent: true, opacity: 0.55 }),
      roof: std(0x8a4b3c), roofSel: sel(0x8a4b3c),
      core: new THREE.MeshStandardMaterial({ color: 0x565c64, roughness: 0.55, metalness: 0.45 }),
      parapet: std(0xcfd3d8), mech: std(0x8b9199),
      deck: std(0x35393f), stone: std(0xb7b1a6), rail: new THREE.MeshStandardMaterial({ color: 0x9099a0, roughness: 0.5, metalness: 0.5 }),
      edge: new THREE.LineBasicMaterial({ color: 0x20242b }),
      edgeSel: new THREE.LineBasicMaterial({ color: accent }),
      preview: new THREE.LineBasicMaterial({ color: accent }),
    }
    // Reflective curtain-wall glass, a few realistic tints picked per building.
    this.glassPalette = [0x9fb8cc, 0x8fb3a8, 0xb9a48c, 0x9aa2ad, 0x66707d].map(c =>
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.08, metalness: 0.9, envMapIntensity: 1.3, side: THREE.DoubleSide }))
  }

  // ---- Geometry rebuild --------------------------------------------------
  protected rebuild() {
    this.ensureMaterials()
    this.clearContent()
    const m = this.model
    const openingsByWall = new Map<string, ArchOpening[]>()
    for (const o of m.openings) {
      const arr = openingsByWall.get(o.wallId) ?? []
      arr.push(o); openingsByWall.set(o.wallId, arr)
    }
    for (const slab of m.slabs) {
      const mesh = buildSlab(slab, this.sel(slab.id) ? this.mats.slabSel : this.mats.slab)
      if (mesh) this.content.add(withEdges(mesh, this.mats.edge, slab.id))
    }
    for (const road of m.roads) {
      for (const mesh of buildRoad(road, this.sel(road.id) ? this.mats.roadSel : this.mats.road)) this.content.add(withEdges(mesh, this.mats.edge, road.id))
    }
    for (const roof of m.roofs) {
      const mesh = buildRoof(roof, this.sel(roof.id) ? this.mats.roofSel : this.mats.roof)
      if (mesh) this.content.add(withEdges(mesh, this.mats.edge, roof.id))
    }
    for (const b of m.buildings) {
      const glass = this.glassPalette[b.seed % this.glassPalette.length]
      const g = buildBuilding(b, { glass, core: this.mats.core, parapet: this.mats.parapet, mech: this.mats.mech, roof: this.mats.roof })
      if (this.sel(b.id)) this.outline(g)
      this.content.add(g)
    }
    for (const br of m.bridges) {
      const g = buildBridge(br, { deck: this.mats.deck, stone: this.mats.stone, rail: this.mats.rail })
      if (this.sel(br.id)) this.outline(g)
      this.content.add(g)
    }
    for (const wall of m.walls) {
      const ops = openingsByWall.get(wall.id) ?? []
      for (const mesh of buildWall(wall, ops, this.sel(wall.id) ? this.mats.wallSel : this.mats.wall)) this.content.add(withEdges(mesh, this.mats.edge, wall.id))
      for (const o of ops) {
        const mat = o.kind === 'door'
          ? (this.sel(o.id) ? this.mats.doorSel : this.mats.door)
          : (this.sel(o.id) ? this.mats.glassSel : this.mats.glass)
        const panel = buildOpeningPanel(wall, o, mat)
        if (panel) this.content.add(withEdges(panel, this.mats.edge, o.id))
      }
    }
  }

  private sel(id: string): boolean { return this.isSel(id) }

  // ---- Snapping ----------------------------------------------------------
  private snapDist(): number { return Math.max(this.ctx.gridStepMm, 120) }

  private nearestEndpoint(p: Vec2): Vec2 | null {
    let best: Vec2 | null = null
    let bestD = this.snapDist()
    for (const w of this.model.walls) {
      for (const e of [w.a, w.b]) {
        const d = dist(p, e)
        if (d < bestD) { bestD = d; best = e }
      }
    }
    return best
  }

  private snapPoint(world: Vec2, ref: Vec2 | null): Vec2 {
    const ep = this.nearestEndpoint(world)
    if (ep) return ep
    const raw = ref ? constrainOrtho(ref, world) : world
    return this.snap(raw)
  }

  // ---- Tool interaction --------------------------------------------------
  protected onToolDown(world: Vec2) {
    const d = this.model.defaults
    switch (this.tool) {
      case 'wall':
      case 'road': {
        const p = this.snapPoint(world, this.lastPoint)
        if (!this.lastPoint) { this.lastPoint = p; break }
        if (dist(this.lastPoint, p) < 1) break
        if (this.tool === 'wall') {
          this.model.walls.push({ id: uid('w'), a: this.lastPoint, b: p, thickness: d.wallThickness, height: d.wallHeight })
        } else {
          this.model.roads.push({ id: uid('r'), path: [this.lastPoint, p], width: d.roadWidth })
        }
        this.lastPoint = p
        this.committed()
        break
      }
      case 'room': {
        const p = this.snapPoint(world, this.roomStart)
        if (!this.roomStart) { this.roomStart = p; break }
        this.createRoom(this.roomStart, p)
        this.roomStart = null
        break
      }
      case 'door':
      case 'window':
        this.placeOpening(world, this.tool as OpeningKind)
        break
    }
    this.updatePreview()
  }

  protected onToolMove(world: Vec2 | null) {
    this.hover = world
    this.updatePreview()
  }

  protected onCommit() { this.resetDrawing() }
  protected onCancel() { this.resetDrawing() }

  private resetDrawing() {
    this.lastPoint = null
    this.roomStart = null
    this.clearPreview()
  }

  private createRoom(a: Vec2, c: Vec2) {
    if (Math.abs(a.x - c.x) < 1 || Math.abs(a.y - c.y) < 1) return
    const d = this.model.defaults
    const corners: Vec2[] = [
      { x: a.x, y: a.y }, { x: c.x, y: a.y }, { x: c.x, y: c.y }, { x: a.x, y: c.y },
    ]
    this.model.slabs.push({ id: uid('s'), poly: corners })
    for (let i = 0; i < 4; i++) {
      this.model.walls.push({
        id: uid('w'), a: corners[i], b: corners[(i + 1) % 4],
        thickness: d.wallThickness, height: d.wallHeight,
      })
    }
    this.committed()
  }

  private placeOpening(world: Vec2, kind: OpeningKind) {
    let bestWall: string | null = null
    let bestT = 0
    let bestD = 500 // mm search radius
    for (const w of this.model.walls) {
      const { t, dist: dd } = closestOnSegment(world, w.a, w.b)
      if (dd < bestD) { bestD = dd; bestWall = w.id; bestT = t }
    }
    if (!bestWall) return
    const d = this.model.defaults
    const op: ArchOpening = kind === 'door'
      ? { id: uid('o'), wallId: bestWall, t: bestT, width: d.doorWidth, height: d.doorHeight, sill: 0, kind }
      : { id: uid('o'), wallId: bestWall, t: bestT, width: d.windowWidth, height: d.windowHeight, sill: d.windowSill, kind }
    this.model.openings.push(op)
    this.committed()
  }

  // ---- Picking / deletion ------------------------------------------------
  protected onPick(_world: Vec2, ev: PointerEvent) {
    this.select(this.pickedId(ev), ev.shiftKey || ev.ctrlKey || ev.metaKey)
  }

  deleteSelection() {
    if (!this.selection.length) return
    const ids = new Set(this.selection)
    const m = this.model
    m.walls = m.walls.filter(w => !ids.has(w.id))
    m.slabs = m.slabs.filter(s => !ids.has(s.id))
    m.roads = m.roads.filter(r => !ids.has(r.id))
    m.roofs = m.roofs.filter(r => !ids.has(r.id))
    m.buildings = m.buildings.filter(b => !ids.has(b.id))
    m.bridges = m.bridges.filter(b => !ids.has(b.id))
    m.openings = m.openings.filter(o => !ids.has(o.id) && m.walls.some(w => w.id === o.wallId))
    this.selection = []
    this.committed()
  }

  /** Accent wireframe over a generated group (buildings/bridges) when selected. */
  private outline(group: THREE.Object3D) {
    const meshes: THREE.Mesh[] = []
    group.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh) })
    for (const mesh of meshes) {
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 30), this.mats.edgeSel)
      mesh.add(e) // inherits the mesh transform
    }
  }

  // ---- Ribbon commands: roof, procedural generation, property edits -------
  protected applyCommand(name: string, payload: unknown) {
    const p = (payload ?? {}) as { type?: RoofType; style?: BuildingStyle; floors?: number; seed?: number; roof?: RoofType | 'none'; spans?: number; arch?: boolean; key?: string; value?: number }
    if (name === 'roof') this.addRoof(p.type ?? 'gable')
    else if (name === 'building') this.addBuilding(p.style ?? 'flat', p.floors ?? this.model.defaults.floors, p.seed ?? 1, p.roof ?? ((p.floors ?? 6) <= 3 ? 'gable' : 'none'))
    else if (name === 'skyscraper') this.addBuilding('setback', Math.max(20, p.floors ?? 40), p.seed ?? 1, 'none')
    else if (name === 'bridge') this.addBridge(p.spans ?? 4, p.arch ?? true)
    else if (name === 'city') this.addCity(p.seed ?? 1)
    else if (name === 'setProp') this.setProp(payload as { key: string; value: number })
  }

  private defaultRect(w: number, d: number) {
    return { x0: -w / 2, z0: -d / 2, x1: w / 2, z1: d / 2 }
  }

  private addBuilding(style: BuildingStyle, floors: number, seed: number, roof: RoofType | 'none') {
    const slab = this.model.slabs.find(s => s.id === this.primarySel())
    const footprint = slab ? slab.poly.map(p => ({ ...p })) : rectPoly(this.defaultRect(style === 'flat' ? 16000 : 22000, style === 'flat' ? 12000 : 22000))
    const b = makeBuilding(footprint, { floors, floorHeight: this.model.defaults.floorHeight, style, seed, roof })
    this.model.buildings.push(b)
    this.selection = [b.id]
    this.committed()
    this.h.fitView()
  }

  private addBridge(spans: number, arch: boolean) {
    const road = this.model.roads.find(r => r.id === this.primarySel())
    const path = road ? road.path.map(p => ({ ...p })) : [{ x: -15000, y: 0 }, { x: 15000, y: 0 }]
    const b: ArchBridge = { id: uid('brg'), path, width: road ? road.width : 6000, deckHeight: 6000, spans, arch }
    this.model.bridges.push(b)
    this.selection = [b.id]
    this.committed()
    this.h.fitView()
  }

  private addCity(seed: number) {
    const o = defaultCityOptions(seed, { x: 0, y: 0 })
    const { roads, buildings } = generateCity(o)
    this.model.roads.push(...roads)
    this.model.buildings.push(...buildings)
    this.selection = []
    this.committed()
    this.h.fitView()
  }

  private addRoof(type: RoofType) {
    const slab = this.model.slabs.find(s => s.id === this.primarySel())
    if (!slab) return
    const d = this.model.defaults
    const roof: ArchRoof = {
      id: uid('roof'), footprint: slab.poly.map(p => ({ ...p })), type,
      base: d.wallHeight, rise: d.roofRise, overhang: d.roofOverhang,
    }
    this.model.roofs.push(roof)
    this.selection = [roof.id]
    this.committed()
  }

  private setProp({ key, value }: { key: string; value: number }) {
    const id = this.primarySel()
    if (!id) return
    const mm = unitToMm(value, this.ctx.unit) // all Architect props are lengths
    const m = this.model
    const wall = m.walls.find(w => w.id === id)
    if (wall) { if (key === 'thickness') wall.thickness = mm; else if (key === 'height') wall.height = mm; this.committed(); return }
    const op = m.openings.find(o => o.id === id)
    if (op) { if (key === 'width') op.width = mm; else if (key === 'height') op.height = mm; else if (key === 'sill') op.sill = mm; this.committed(); return }
    const road = m.roads.find(r => r.id === id)
    if (road) { if (key === 'width') road.width = mm; this.committed(); return }
    const roof = m.roofs.find(r => r.id === id)
    if (roof) { if (key === 'rise') roof.rise = mm; else if (key === 'overhang') roof.overhang = mm; this.committed(); return }
    const building = m.buildings.find(b => b.id === id)
    if (building) {
      if (key === 'floors') building.floors = Math.max(1, Math.round(value))
      else if (key === 'floorHeight') building.floorHeight = mm
      this.committed(); return
    }
    const bridge = m.bridges.find(b => b.id === id)
    if (bridge) {
      if (key === 'spans') bridge.spans = Math.max(2, Math.round(value))
      else if (key === 'deckHeight') bridge.deckHeight = mm
      else if (key === 'width') bridge.width = mm
      this.committed(); return
    }
  }

  protected selectionInfo(): SelectionInfo | null {
    const id = this.primarySel()
    if (!id) return null
    const count = this.selection.length
    const u = this.ctx.unit
    const L = (key: string, label: string, mm: number, min = 0): SelField =>
      ({ key, label, value: mmToUnit(mm, u), unit: u, min: mmToUnit(min, u), step: unitStep(u) })
    const m = this.model
    const wall = m.walls.find(w => w.id === id)
    if (wall) return { title: 'Mur', count, fields: [L('thickness', 'Épaisseur', wall.thickness, 20), L('height', 'Hauteur', wall.height, 100)] }
    const op = m.openings.find(o => o.id === id)
    if (op) {
      const f = [L('width', 'Largeur', op.width, 100), L('height', 'Hauteur', op.height, 100)]
      if (op.kind === 'window') f.push(L('sill', 'Allège', op.sill, 0))
      return { title: op.kind === 'door' ? 'Porte' : 'Fenêtre', count, fields: f }
    }
    const road = m.roads.find(r => r.id === id)
    if (road) return { title: 'Route', count, fields: [L('width', 'Largeur', road.width, 500)] }
    const roof = m.roofs.find(r => r.id === id)
    if (roof) return { title: 'Toit', count, fields: [L('rise', 'Pente (haut.)', roof.rise, 0), L('overhang', 'Débord', roof.overhang, 0)] }
    const R = (key: string, label: string, value: number, min: number): SelField => ({ key, label, value, min, step: 1 })
    const building = m.buildings.find(b => b.id === id)
    if (building) return { title: 'Bâtiment', count, fields: [R('floors', 'Étages', building.floors, 1), L('floorHeight', 'H. étage', building.floorHeight, 2000)] }
    const bridge = m.bridges.find(b => b.id === id)
    if (bridge) return { title: 'Pont', count, fields: [R('spans', 'Travées', bridge.spans, 2), L('deckHeight', 'Tablier (h.)', bridge.deckHeight, 0), L('width', 'Largeur', bridge.width, 1000)] }
    if (m.slabs.some(s => s.id === id)) return { title: 'Dalle', count, fields: [] }
    return null
  }

  // ---- Preview + labels --------------------------------------------------
  private clearPreview() {
    for (let i = this.previewGroup.children.length - 1; i >= 0; i--) {
      const o = this.previewGroup.children[i] as THREE.Line
      this.previewGroup.remove(o)
      o.geometry.dispose()
    }
  }

  private lineFrom(pts: Vec2[], y = 20) {
    const g = new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(p.x, y, p.y)))
    this.previewGroup.add(new THREE.Line(g, this.mats.preview))
  }

  private updatePreview() {
    this.clearPreview()
    if (!this.hover) return
    if ((this.tool === 'wall' || this.tool === 'road') && this.lastPoint) {
      this.lineFrom([this.lastPoint, this.snapPoint(this.hover, this.lastPoint)])
    } else if (this.tool === 'room' && this.roomStart) {
      const c = this.snapPoint(this.hover, this.roomStart)
      const a = this.roomStart
      this.lineFrom([a, { x: c.x, y: a.y }, c, { x: a.x, y: c.y }, a])
    }
  }

  private projectVec2(p: Vec2, y = 40) { return this.h.project(new THREE.Vector3(p.x, y, p.y)) }

  protected drawLabels() {
    if (!this.mats) return
    const unit = this.ctx.unit
    // Live length while drawing a wall/road segment.
    if ((this.tool === 'wall' || this.tool === 'road') && this.lastPoint && this.hover) {
      const b = this.snapPoint(this.hover, this.lastPoint)
      const mid = { x: (this.lastPoint.x + b.x) / 2, y: (this.lastPoint.y + b.y) / 2 }
      const l = len(sub(b, this.lastPoint))
      if (l > 1) this.labels.add(formatLength(l, unit), this.projectVec2(mid), { color: '#fff', bold: true })
    }
    if (this.tool === 'room' && this.roomStart && this.hover) {
      const c = this.snapPoint(this.hover, this.roomStart)
      const a = this.roomStart
      const w = Math.abs(c.x - a.x), h = Math.abs(c.y - a.y)
      this.labels.add(formatLength(w, unit), this.projectVec2({ x: (a.x + c.x) / 2, y: a.y }), { bold: true })
      this.labels.add(formatLength(h, unit), this.projectVec2({ x: a.x, y: (a.y + c.y) / 2 }), { bold: true })
      if (w > 1 && h > 1) this.labels.add(formatArea(w * h, unit), this.projectVec2({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }), { color: '#fff' })
    }
    // Dimension for the selected element.
    const id = this.primarySel()
    if (id) {
      const wall = this.model.walls.find(w => w.id === id)
      if (wall) {
        const mid = { x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 }
        this.labels.add(formatLength(dist(wall.a, wall.b), unit), this.projectVec2(mid), { color: '#fff', bold: true })
      }
      const slab = this.model.slabs.find(s => s.id === id)
      if (slab) {
        const cx = slab.poly.reduce((a, p) => a + p.x, 0) / slab.poly.length
        const cy = slab.poly.reduce((a, p) => a + p.y, 0) / slab.poly.length
        this.labels.add(formatArea(polygonArea(slab.poly), unit), this.projectVec2({ x: cx, y: cy }), { color: '#fff', bold: true })
      }
    }
  }

  dispose() {
    this.h.scene.remove(this.previewGroup)
    this.clearPreview()
    if (this.mats) Object.values(this.mats).forEach(m => (m as THREE.Material).dispose())
    if (this.glassPalette) this.glassPalette.forEach(m => m.dispose())
    super.dispose()
  }
}
