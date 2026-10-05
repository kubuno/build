import * as THREE from 'three'
import { dist, normalize, sub, type Vec2 } from './geometry'
import type { ArchBridge, ArchBuilding, ArchOpening, ArchRoad, ArchRoof, ArchSlab, ArchWall } from './architectModel'
import { boundingRect, inset, rectPoly, type Rect } from './procedural'

// Turns the Architect model into three.js meshes. Walls become oriented boxes;
// openings split a wall into pillars plus a header (and a sill for windows), so
// doors/windows read as real gaps in both the 2D top view and the 3D elevation —
// no CSG needed. Every mesh is tagged with userData.eid for picking.

/** A box oriented along `dir`, centred on the wall centre-line, from yBottom→yTop. */
function orientedBox(
  center: Vec2, dir: Vec2, length: number, thickness: number,
  yBottom: number, yTop: number, material: THREE.Material, eid: string,
): THREE.Mesh | null {
  const h = yTop - yBottom
  if (length <= 0.5 || h <= 0.5) return null
  const geo = new THREE.BoxGeometry(length, h, thickness)
  const mesh = new THREE.Mesh(geo, material)
  mesh.position.set(center.x, (yBottom + yTop) / 2, center.y)
  mesh.rotation.y = Math.atan2(-dir.y, dir.x)
  mesh.userData.eid = eid
  return mesh
}

export function buildWall(wall: ArchWall, openings: ArchOpening[], material: THREE.Material): THREE.Mesh[] {
  const L = dist(wall.a, wall.b)
  if (L < 1) return []
  const dir = normalize(sub(wall.b, wall.a))
  const meshes: THREE.Mesh[] = []

  const at = (mm: number): Vec2 => ({ x: wall.a.x + dir.x * mm, y: wall.a.y + dir.y * mm })
  const clamp = (v: number) => Math.max(0, Math.min(L, v))

  const spans = openings
    .map(o => { const c = o.t * L; return { o, s0: clamp(c - o.width / 2), s1: clamp(c + o.width / 2) } })
    .sort((a, b) => a.s0 - b.s0)

  const push = (s0: number, s1: number, yb: number, yt: number) => {
    const mid = (s0 + s1) / 2
    const m = orientedBox(at(mid), dir, s1 - s0, wall.thickness, yb, yt, material, wall.id)
    if (m) meshes.push(m)
  }

  // Full-height pillars = the wall minus the opening spans.
  let cursor = 0
  for (const s of spans) {
    if (s.s0 > cursor) push(cursor, s.s0, 0, wall.height)
    cursor = Math.max(cursor, s.s1)
  }
  if (cursor < L) push(cursor, L, 0, wall.height)

  // Headers (and sills for windows) over each opening.
  for (const { o, s0, s1 } of spans) {
    if (o.kind === 'door') {
      push(s0, s1, o.height, wall.height)
    } else {
      push(s0, s1, 0, o.sill)
      push(s0, s1, o.sill + o.height, wall.height)
    }
  }
  return meshes
}

/** A thin panel filling an opening — a door leaf or a glazed window pane. Makes
 *  openings visible in 3D and pickable (tagged with the opening id). */
export function buildOpeningPanel(wall: ArchWall, o: ArchOpening, material: THREE.Material): THREE.Mesh | null {
  const L = dist(wall.a, wall.b)
  if (L < 1) return null
  const dir = normalize(sub(wall.b, wall.a))
  const c = o.t * L
  const s0 = Math.max(0, c - o.width / 2)
  const s1 = Math.min(L, c + o.width / 2)
  const yb = o.kind === 'door' ? 0 : o.sill
  const yt = o.kind === 'door' ? o.height : o.sill + o.height
  const mid = (s0 + s1) / 2
  const center: Vec2 = { x: wall.a.x + dir.x * mid, y: wall.a.y + dir.y * mid }
  const panel = orientedBox(center, dir, s1 - s0, wall.thickness * 0.34, yb, yt, material, o.id)
  return panel
}

function flatShape(poly: Vec2[]): THREE.ShapeGeometry | null {
  if (poly.length < 3) return null
  const shape = new THREE.Shape()
  shape.moveTo(poly[0].x, poly[0].y)
  for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i].x, poly[i].y)
  shape.closePath()
  const geo = new THREE.ShapeGeometry(shape)
  geo.rotateX(Math.PI / 2) // XY sketch → XZ ground (keeps Vec2.y → world.z)
  return geo
}

export function buildSlab(slab: ArchSlab, material: THREE.Material, yLevel = -3): THREE.Mesh | null {
  const geo = flatShape(slab.poly)
  if (!geo) return null
  const mesh = new THREE.Mesh(geo, material)
  mesh.position.y = yLevel
  mesh.userData.eid = slab.id
  return mesh
}

// Roof over a rectangular footprint. The ridge runs along the longer side.
// gable = two slopes + triangular gable ends; hip = four slopes; flat = a slab.
// Faces are emitted as a triangle soup with computed (flat) normals.
export function buildRoof(roof: ArchRoof, material: THREE.Material): THREE.Mesh | null {
  const xs = roof.footprint.map(p => p.x)
  const zs = roof.footprint.map(p => p.y)
  const o = roof.overhang
  const x0 = Math.min(...xs) - o, x1 = Math.max(...xs) + o
  const z0 = Math.min(...zs) - o, z1 = Math.max(...zs) + o
  if (x1 - x0 < 1 || z1 - z0 < 1) return null
  const b = roof.base
  const r = roof.base + roof.rise

  const pos: number[] = []
  const V = (x: number, y: number, z: number) => [x, y, z]
  const tri = (a: number[], c: number[], d: number[]) => pos.push(...a, ...c, ...d)
  const quad = (a: number[], c: number[], d: number[], e: number[]) => { tri(a, c, d); tri(a, d, e) }

  if (roof.type === 'flat') {
    const th = 150
    // Top and four sides of a thin slab (bottom omitted — sits on the walls).
    const c00 = V(x0, b + th, z0), c10 = V(x1, b + th, z0), c11 = V(x1, b + th, z1), c01 = V(x0, b + th, z1)
    quad(c00, c10, c11, c01)
    const d00 = V(x0, b, z0), d10 = V(x1, b, z0), d11 = V(x1, b, z1), d01 = V(x0, b, z1)
    quad(d00, c00, c01, d01); quad(d10, d00, c00, c10); quad(d11, d10, c10, c11); quad(d01, c01, c11, d11)
  } else {
    const alongX = (x1 - x0) >= (z1 - z0)
    const zmid = (z0 + z1) / 2, xmid = (x0 + x1) / 2
    if (roof.type === 'gable') {
      if (alongX) {
        quad(V(x0, b, z0), V(x1, b, z0), V(x1, r, zmid), V(x0, r, zmid))
        quad(V(x0, r, zmid), V(x1, r, zmid), V(x1, b, z1), V(x0, b, z1))
        tri(V(x0, b, z0), V(x0, r, zmid), V(x0, b, z1))
        tri(V(x1, b, z0), V(x1, b, z1), V(x1, r, zmid))
      } else {
        quad(V(x0, b, z0), V(xmid, r, z0), V(xmid, r, z1), V(x0, b, z1))
        quad(V(xmid, r, z0), V(x1, b, z0), V(x1, b, z1), V(xmid, r, z1))
        tri(V(x0, b, z0), V(x1, b, z0), V(xmid, r, z0))
        tri(V(x0, b, z1), V(xmid, r, z1), V(x1, b, z1))
      }
    } else { // hip
      if (alongX) {
        const inset = Math.min((z1 - z0) / 2, (x1 - x0) / 2)
        const R0 = V(x0 + inset, r, zmid), R1 = V(x1 - inset, r, zmid)
        quad(V(x0, b, z0), V(x1, b, z0), R1, R0)
        quad(V(x0, b, z1), R0, R1, V(x1, b, z1))
        tri(V(x0, b, z0), R0, V(x0, b, z1))
        tri(V(x1, b, z0), V(x1, b, z1), R1)
      } else {
        const inset = Math.min((x1 - x0) / 2, (z1 - z0) / 2)
        const R0 = V(xmid, r, z0 + inset), R1 = V(xmid, r, z1 - inset)
        quad(V(x0, b, z0), V(x0, b, z1), R1, R0)
        quad(V(x1, b, z0), R0, R1, V(x1, b, z1))
        tri(V(x0, b, z0), R0, V(x1, b, z0))
        tri(V(x0, b, z1), V(x1, b, z1), R1)
      }
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(geo, material)
  mesh.userData.eid = roof.id
  return mesh
}

export function buildRoad(road: ArchRoad, material: THREE.Material, yLevel = 8): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = []
  const half = road.width / 2
  for (let i = 0; i < road.path.length - 1; i++) {
    const p = road.path[i], q = road.path[i + 1]
    const d = normalize(sub(q, p))
    const n = { x: -d.y * half, y: d.x * half }
    const quad = [
      { x: p.x + n.x, y: p.y + n.y },
      { x: q.x + n.x, y: q.y + n.y },
      { x: q.x - n.x, y: q.y - n.y },
      { x: p.x - n.x, y: p.y - n.y },
    ]
    const geo = flatShape(quad)
    if (!geo) continue
    const mesh = new THREE.Mesh(geo, material)
    mesh.position.y = yLevel
    mesh.userData.eid = road.id
    meshes.push(mesh)
  }
  return meshes
}

// ---- Procedural building --------------------------------------------------
interface Tier extends Rect { floors: number; y0: number }

function tierList(b: ArchBuilding, rect: Rect): Tier[] {
  if (b.style === 'flat') return [{ ...rect, floors: b.floors, y0: b.base }]
  const steps = b.style === 'setback' ? 3 : 5
  const minSide = Math.min(rect.x1 - rect.x0, rect.z1 - rect.z0)
  const insetStep = minSide * (b.style === 'setback' ? 0.14 : 0.08)
  const weights = Array.from({ length: steps }, (_, i) => steps - i)
  const wsum = weights.reduce((a, c) => a + c, 0)
  const tiers: Tier[] = []
  let y = b.base, assigned = 0
  for (let i = 0; i < steps; i++) {
    const f = i === steps - 1 ? b.floors - assigned : Math.max(1, Math.round((b.floors * weights[i]) / wsum))
    if (f <= 0) break
    assigned += f
    const cur = i === 0 ? rect : inset(rect, insetStep * i)
    if (cur.x1 - cur.x0 < 1000 || cur.z1 - cur.z0 < 1000) break
    tiers.push({ ...cur, floors: f, y0: y })
    y += f * b.floorHeight
  }
  return tiers.length ? tiers : [{ ...rect, floors: b.floors, y0: b.base }]
}

export interface BuildingMats {
  glass: THREE.Material   // reflective outer curtain-wall skin (varies by seed)
  core: THREE.Material    // recessed spandrel/mullion behind the glass
  parapet: THREE.Material // roof crown / terrace edge
  mech: THREE.Material    // rooftop mechanical / penthouse
  roof: THREE.Material    // pitched roof for low houses
}

// Push a curtain-wall of recessed glass panels along one facade edge A→B.
// Panels sit at the facade plane; the darker core behind shows through the
// margins as mullions + spandrel bands, giving real depth and shadow.
function pushWall(A: Vec2, B: Vec2, yBase: number, floors: number, fh: number, pos: number[], nor: number[]) {
  const d = normalize(sub(B, A))
  const L = dist(A, B)
  if (L < 300) return
  const n = { x: d.y, y: -d.x } // outward normal (footprint wound CW in XZ)
  const bays = Math.max(1, Math.round(L / 2400))
  const bw = L / bays
  const marginX = Math.min(240, bw * 0.16)
  const nx = n.x, nz = n.y
  const P = (along: number, y: number): [number, number, number] =>
    [A.x + d.x * along, y, A.y + d.y * along]
  for (let bay = 0; bay < bays; bay++) {
    const a0 = bay * bw + marginX, a1 = (bay + 1) * bw - marginX
    if (a1 - a0 < 200) continue
    for (let f = 0; f < floors; f++) {
      const ground = f === 0
      const yb = yBase + f * fh + (ground ? 300 : 620)
      const yt = yBase + (f + 1) * fh - 260
      if (yt - yb < 250) continue
      const q00 = P(a0, yb), q10 = P(a1, yb), q11 = P(a1, yt), q01 = P(a0, yt)
      for (const [x, y, z] of [q00, q10, q11, q00, q11, q01]) { pos.push(x, y, z); nor.push(nx, 0, nz) }
    }
  }
}

function tierGlass(rect: Rect, yBase: number, floors: number, fh: number): THREE.BufferGeometry | null {
  const pos: number[] = [], nor: number[] = []
  const c: Vec2[] = [{ x: rect.x0, y: rect.z0 }, { x: rect.x1, y: rect.z0 }, { x: rect.x1, y: rect.z1 }, { x: rect.x0, y: rect.z1 }]
  for (let i = 0; i < 4; i++) pushWall(c[i], c[(i + 1) % 4], yBase, floors, fh, pos, nor)
  if (!pos.length) return null
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  return g
}

function box(w: number, h: number, d: number, cx: number, cy: number, cz: number, mat: THREE.Material, eid: string): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
  m.position.set(cx, cy, cz)
  m.userData.eid = eid
  return m
}

/** A procedural building: recessed glass curtain-wall over a spandrel core,
 *  stacked tiers (setback/taper), a parapet crown and rooftop plant. */
export function buildBuilding(b: ArchBuilding, mats: BuildingMats): THREE.Group {
  const rect = boundingRect(b.footprint)
  const group = new THREE.Group()
  group.userData.eid = b.id
  const tiers = tierList(b, rect)
  const fh = b.floorHeight

  for (let ti = 0; ti < tiers.length; ti++) {
    const t = tiers[ti]
    const w = t.x1 - t.x0, d = t.z1 - t.z0, H = t.floors * fh
    if (w < 500 || d < 500 || H < 1) continue
    const cx = (t.x0 + t.x1) / 2, cz = (t.z0 + t.z1) / 2
    // Spandrel/mullion core, recessed ~130mm behind the glass skin.
    group.add(box(w - 260, H, d - 260, cx, t.y0 + H / 2, cz, mats.core, b.id))
    // Glass curtain-wall skin at the facade plane.
    const gg = tierGlass(t, t.y0, t.floors, fh)
    if (gg) { const gm = new THREE.Mesh(gg, mats.glass); gm.userData.eid = b.id; group.add(gm) }
    // A slim parapet crown / terrace edge at each tier top.
    const topY = t.y0 + H
    group.add(box(w + 60, 320, d + 60, cx, topY + 160, cz, mats.parapet, b.id))
  }

  const top = tiers[tiers.length - 1]
  const topY = top ? top.y0 + top.floors * fh : b.base
  if (b.roof !== 'none' && top) {
    const w = top.x1 - top.x0, d = top.z1 - top.z0
    const roof = buildRoof({ id: b.id, footprint: rectPoly(top), type: b.roof, base: topY + 500, rise: Math.min(w, d) * 0.35, overhang: 350 }, mats.roof)
    if (roof) group.add(roof)
  } else if (top) {
    // Flat-roof plant: a small mechanical penthouse (mid/high-rise only) and an
    // antenna mast on tall towers. Low buildings keep a clean roof.
    const w = top.x1 - top.x0, d = top.z1 - top.z0
    const mcx = (top.x0 + top.x1) / 2, mcz = (top.z0 + top.z1) / 2
    if (b.floors >= 8) {
      const mw = Math.max(1000, w * 0.28), md = Math.max(1000, d * 0.28)
      const mh = fh * 0.9
      group.add(box(mw, mh, md, mcx, topY + 320 + mh / 2, mcz, mats.mech, b.id))
    }
    if (b.floors > 22) {
      const mastH = b.floors * fh * 0.16
      group.add(box(180, mastH, 180, mcx, topY + 320 + fh * 0.9 + mastH / 2, mcz, mats.mech, b.id))
    }
  }
  return group
}

// ---- Procedural bridge ----------------------------------------------------
function pointAt(path: Vec2[], dq: number): { p: Vec2; dir: Vec2 } {
  let acc = 0
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1]
    const l = dist(a, b)
    if (acc + l >= dq || i === path.length - 2) {
      const t = l > 1e-6 ? (dq - acc) / l : 0
      return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, dir: normalize(sub(b, a)) }
    }
    acc += l
  }
  return { p: path[0], dir: { x: 1, y: 0 } }
}

export interface BridgeMats {
  deck: THREE.Material  // road surface
  stone: THREE.Material // masonry spandrel walls / piers
  rail: THREE.Material  // parapet railings
}

/** A masonry arch viaduct: spandrel walls pierced by arches carry an elevated
 *  deck with parapet railings. Reads like a real bridge, not a toy. */
export function buildBridge(bridge: ArchBridge, mats: BridgeMats): THREE.Group {
  const group = new THREE.Group()
  group.userData.eid = bridge.id
  const half = bridge.width / 2
  const deckTh = Math.max(400, bridge.width * 0.14)
  const yDeck = bridge.deckHeight

  let total = 0
  for (let i = 0; i < bridge.path.length - 1; i++) total += dist(bridge.path[i], bridge.path[i + 1])
  const n = Math.max(1, bridge.spans)
  const span = total / n

  // Deck + parapet railings (one per path segment).
  for (let i = 0; i < bridge.path.length - 1; i++) {
    const p = bridge.path[i], q = bridge.path[i + 1]
    const d = normalize(sub(q, p))
    const L = dist(p, q)
    const cx = (p.x + q.x) / 2, cz = (p.y + q.y) / 2
    const rotY = Math.atan2(-d.y, d.x)
    const deck = box(L, deckTh, bridge.width, cx, yDeck + deckTh / 2, cz, mats.deck, bridge.id)
    deck.rotation.y = rotY; group.add(deck)
    const nrm = { x: -d.y, y: d.x }
    for (const s of [1, -1]) {
      const rail = box(L, 1100, 240, cx + nrm.x * s * (half - 120), yDeck + deckTh + 550, cz + nrm.y * s * (half - 120), mats.rail, bridge.id)
      rail.rotation.y = rotY; group.add(rail)
    }
  }

  // Spandrel walls pierced by arches (masonry), spanning pier to pier.
  const wallW = bridge.width * 0.9
  const archR = Math.min(span * 0.42, yDeck * 0.9)
  for (let i = 0; i < n; i++) {
    const mid = pointAt(bridge.path, (total * (i + 0.5)) / n)
    const wall = makeSpanWall(mid.p, mid.dir, span, wallW, yDeck, bridge.arch ? archR : 0, mats.stone, bridge.id)
    if (wall) group.add(wall)
  }
  return group
}

// A spandrel wall (rectangle) in the (u, height) plane, optionally pierced by a
// semicircular arch opening, extruded across the bridge width and oriented.
function makeSpanWall(center: Vec2, dir: Vec2, span: number, width: number, height: number, archR: number, material: THREE.Material, eid: string): THREE.Mesh | null {
  if (span < 200 || height < 200) return null
  const hs = span / 2
  const shape = new THREE.Shape()
  shape.moveTo(-hs, 0)
  shape.lineTo(hs, 0)
  shape.lineTo(hs, height)
  shape.lineTo(-hs, height)
  shape.closePath()
  if (archR > 100) {
    const hole = new THREE.Path()
    hole.moveTo(archR, 0)
    hole.absarc(0, 0, archR, 0, Math.PI, false)
    hole.lineTo(archR, 0)
    shape.holes.push(hole)
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, curveSegments: 28 })
  geo.translate(0, 0, -width / 2)
  const ex = new THREE.Vector3(dir.x, 0, dir.y)
  const ey = new THREE.Vector3(0, 1, 0)
  const ez = new THREE.Vector3(-dir.y, 0, dir.x)
  const m = new THREE.Matrix4().makeBasis(ex, ey, ez)
  m.setPosition(center.x, 0, center.y)
  geo.applyMatrix4(m)
  const mesh = new THREE.Mesh(geo, material)
  mesh.userData.eid = eid
  return mesh
}
