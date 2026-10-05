import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Manifold } from 'manifold-3d'
import type { Vec2 } from './geometry'
import { arcPoints, type EdgeMod, type PrimitiveFeature, type SketchEntity, type Vec3Tuple } from './cao3dModel'
import { toWorld, type PlaneBasis } from './sketchPlane'
import { extrudePolygon, kernel, manifoldFromGeometry, revolvePolygon, toPolygon } from './kernel'

// Turns CAO3D sketch entities/features into geometry. Sketch entities live on
// the ground plane (world y = 0), mapping Vec2 {x,y} → world (x, 0, y). Solid
// features produce Manifold solids (see kernel.ts): extrude/revolve are native
// Manifold constructions; lofts and filleted/chamfered primitives are built as
// three.js meshes then converted. Booleans happen on Manifolds in the recompute
// pipeline (cao3dRecompute.ts), which guarantees watertight results and clean
// outline edges even on combined solids.

const CIRCLE_SEGMENTS = 96
const LATHE_SEGMENTS = 96

/** Outline points of a sketch entity, in sketch space (Vec2). */
export function entityPoints(e: SketchEntity): Vec2[] {
  if (e.kind === 'rect') {
    return [{ x: e.a.x, y: e.a.y }, { x: e.b.x, y: e.a.y }, { x: e.b.x, y: e.b.y }, { x: e.a.x, y: e.b.y }]
  }
  if (e.kind === 'circle') {
    const pts: Vec2[] = []
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
      const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2
      pts.push({ x: e.c.x + Math.cos(a) * e.r, y: e.c.y + Math.sin(a) * e.r })
    }
    return pts
  }
  if (e.kind === 'point') return [e.p]
  if (e.kind === 'segment') return [e.a, e.b]
  if (e.kind === 'arc') return arcPoints(e)
  return e.pts
}

const isLoopEntity = (e: SketchEntity) =>
  e.kind === 'rect' || e.kind === 'circle' || (e.kind === 'poly' && e.closed)

/** Line/loop showing a sketch entity on its plane (default: ground level). */
export function buildEntityLine(e: SketchEntity, material: THREE.LineBasicMaterial, lift = 1, basis?: PlaneBasis): THREE.Object3D {
  const pts = entityPoints(e).map(v => basis
    ? toWorld(basis, v, lift)
    : new THREE.Vector3(v.x, lift, v.y))
  if (isLoopEntity(e) && pts.length) pts.push(pts[0].clone())
  const geo = new THREE.BufferGeometry().setFromPoints(pts)
  const line = new THREE.Line(geo, material)
  line.userData.eid = e.id
  return line
}

// ---- Fillet / chamfer primitive shells (three.js, converted to Manifold) ----
function roundedCylinder(r: number, height: number, radius: number): THREE.BufferGeometry {
  // Lathe of a profile (x = radius, y = height) whose outer top+bottom corners
  // are rounded (fillet) — smooth blending is exactly what a fillet wants.
  const rr = Math.min(radius, r * 0.99, height / 2)
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, 0)]
  const seg = 8
  pts.push(new THREE.Vector2(r - rr, 0))
  for (let i = 1; i <= seg; i++) { const a = (-Math.PI / 2) + (i / seg) * (Math.PI / 2); pts.push(new THREE.Vector2(r - rr + Math.cos(a) * rr, rr + Math.sin(a) * rr)) }
  pts.push(new THREE.Vector2(r, height - rr))
  for (let i = 1; i <= seg; i++) { const a = (i / seg) * (Math.PI / 2); pts.push(new THREE.Vector2(r - rr + Math.cos(a) * rr, height - rr + Math.sin(a) * rr)) }
  pts.push(new THREE.Vector2(0, height))
  return new THREE.LatheGeometry(pts, LATHE_SEGMENTS)
}

// A machined chamfer must read as crisp 45° facets — a lathe would smooth the
// crease between wall and bevel. Assemble the cylinder from separate pieces
// (wall, two bevel cones, two caps): vertices are not shared across parts, so
// shading stays smooth AROUND the axis but breaks sharply ACROSS each crease.
// (Manifold re-welds them by position; display normals come from
// calculateNormals with a 30° sharp angle, which keeps those creases crisp.)
function chamferedCylinder(r: number, height: number, chamfer: number): THREE.BufferGeometry {
  const c = Math.max(0.1, Math.min(chamfer, r * 0.9, height / 2 - 0.1))
  const rr = r - c
  const bottom = new THREE.CylinderGeometry(r, rr, c, LATHE_SEGMENTS, 1, true)
  bottom.translate(0, c / 2, 0)
  const wall = new THREE.CylinderGeometry(r, r, height - 2 * c, LATHE_SEGMENTS, 1, true)
  wall.translate(0, height / 2, 0)
  const top = new THREE.CylinderGeometry(rr, r, c, LATHE_SEGMENTS, 1, true)
  top.translate(0, height - c / 2, 0)
  const capB = new THREE.CircleGeometry(rr, LATHE_SEGMENTS)
  capB.rotateX(Math.PI / 2) // face down
  const capT = new THREE.CircleGeometry(rr, LATHE_SEGMENTS)
  capT.rotateX(-Math.PI / 2)
  capT.translate(0, height, 0)
  const parts = [bottom, wall, top, capB, capT]
  const merged = mergeGeometries(parts)
  parts.forEach(p => p.dispose())
  return merged ?? new THREE.CylinderGeometry(r, r, height, LATHE_SEGMENTS, 1, false)
}

// Crisp 45° chamfer on every edge of a box: the convex hull of the 24 offset
// corner points. Hull faces carry flat normals → real machined bevel planes.
function chamferedBox(w: number, h: number, d: number, chamfer: number): THREE.BufferGeometry {
  const hx = w / 2, hy = h / 2, hz = d / 2
  const c = Math.max(0.1, Math.min(chamfer, hx - 0.1, hy - 0.1, hz - 0.1))
  const pts: THREE.Vector3[] = []
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    pts.push(new THREE.Vector3(sx * (hx - c), sy * hy, sz * hz))
    pts.push(new THREE.Vector3(sx * hx, sy * (hy - c), sz * hz))
    pts.push(new THREE.Vector3(sx * hx, sy * hy, sz * (hz - c)))
  }
  return new ConvexGeometry(pts)
}

/** Convert a three.js shell to Manifold, disposing the shell. */
function solidFromShell(geo: THREE.BufferGeometry): Manifold {
  try {
    return manifoldFromGeometry(geo)
  } finally {
    geo.dispose()
  }
}

// ---- Solid builders (Manifold) ----------------------------------------------
/** Extrusion of a closed sketch entity, with optional fillet/chamfer on the
 *  rect/circle primitives (matching the legacy special-case shells). */
export function padSolid(e: SketchEntity, height: number, mod?: EdgeMod): Manifold {
  if (height <= 0) throw new Error('height')
  if (e.kind === 'circle') {
    let m: Manifold
    if (mod && mod.radius > 0) {
      m = solidFromShell(mod.kind === 'fillet'
        ? roundedCylinder(e.r, height, mod.radius)
        : chamferedCylinder(e.r, height, mod.radius))
    } else {
      const cyl = kernel().Manifold.cylinder(height, e.r, e.r, CIRCLE_SEGMENTS)
      m = cyl.rotate(-90, 0, 0)
      cyl.delete()
    }
    const out = m.translate(e.c.x, 0, e.c.y)
    m.delete()
    return out
  }
  if (e.kind === 'poly' && mod && mod.radius > 0) {
    // 2D corner treatment on arbitrary profiles: a morphological opening then
    // closing (CrossSection.offset) rounds/bevels convex AND concave corners
    // of the outline before extrusion (round joins = fillet, square = chamfer).
    const { CrossSection, Manifold } = kernel()
    const join = mod.kind === 'fillet' ? 'Round' : 'Square'
    const r = Math.max(0.1, mod.radius)
    let cs = new CrossSection([toPolygon(entityPoints(e))], 'Positive')
    for (const delta of [-r, 2 * r, -r]) {
      const next = cs.offset(delta, join, 2, 32).simplify(0.005)
      cs.delete()
      cs = next
    }
    const m = Manifold.extrude(cs, height)
    cs.delete()
    const out = m.rotate(-90, 0, 0)
    m.delete()
    return out
  }
  if (e.kind === 'rect' && mod && mod.radius > 0) {
    const w = Math.abs(e.b.x - e.a.x), d = Math.abs(e.b.y - e.a.y)
    const radius = Math.max(0.1, Math.min(mod.radius, w / 2 - 0.1, d / 2 - 0.1, height / 2 - 0.1))
    const shell = mod.kind === 'chamfer'
      ? chamferedBox(w, height, d, radius)
      : new RoundedBoxGeometry(w, height, d, 4, radius)
    const m = solidFromShell(shell)
    const out = m.translate((e.a.x + e.b.x) / 2, height / 2, (e.a.y + e.b.y) / 2)
    m.delete()
    return out
  }
  return extrudePolygon(entityPoints(e), height)
}

/** Revolution of a sketch outline around the sketch X axis. */
export function revolveSolid(e: SketchEntity, angleDeg: number): Manifold {
  return revolvePolygon(entityPoints(e), angleDeg, LATHE_SEGMENTS)
}

// ---- Loft between two entities (mesh soup → Manifold) ------------------------
function resample(pts: Vec2[], k: number): Vec2[] {
  const n = pts.length
  if (n === 0) return []
  const seg: number[] = []
  let total = 0
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n]
    const l = Math.hypot(b.x - a.x, b.y - a.y)
    seg.push(l); total += l
  }
  if (total < 1e-6) return pts.slice(0, k)
  const out: Vec2[] = []
  const step = total / k
  let idx = 0, acc = 0
  for (let s = 0; s < k; s++) {
    const target = s * step
    while (idx < n - 1 && acc + seg[idx] < target) { acc += seg[idx]; idx++ }
    const a = pts[idx], b = pts[(idx + 1) % n]
    const t = seg[idx] > 1e-6 ? (target - acc) / seg[idx] : 0
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
  }
  return out
}

function pushCap(pos: number[], pts: Vec2[], y: number, flip: boolean) {
  const contour = pts.map(p => new THREE.Vector2(p.x, p.y))
  const faces = THREE.ShapeUtils.triangulateShape(contour, [])
  for (const [a, b, c] of faces) {
    const A = pts[a], B = pts[b], C = pts[c]
    if (flip) pos.push(A.x, y, A.y, C.x, y, C.y, B.x, y, B.y)
    else pos.push(A.x, y, A.y, B.x, y, B.y, C.x, y, C.y)
  }
}

export function loftSolid(entityA: SketchEntity, entityB: SketchEntity, height: number): Manifold {
  if (height <= 0) throw new Error('height')
  const K = 96
  const a = resample(entityPoints(entityA), K)
  const b = resample(entityPoints(entityB), K)
  if (a.length < 3 || b.length < 3) throw new Error('profile')
  const pos: number[] = []
  for (let i = 0; i < K; i++) {
    const j = (i + 1) % K
    const a0 = a[i], a1 = a[j], b0 = b[i], b1 = b[j]
    // side quad (a0,a1,b1,b0)
    pos.push(a0.x, 0, a0.y, a1.x, 0, a1.y, b1.x, height, b1.y)
    pos.push(a0.x, 0, a0.y, b1.x, height, b1.y, b0.x, height, b0.y)
  }
  pushCap(pos, a, 0, true)        // bottom cap faces down
  pushCap(pos, b, height, false)  // top cap faces up
  let geo: THREE.BufferGeometry = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo = mergeVertices(geo)
  return solidFromShell(geo)
}

// ---- Parametric primitives (resting on the ground plane) ---------------------
export function primitiveSolid(f: PrimitiveFeature): Manifold {
  const { Manifold, CrossSection } = kernel()
  switch (f.shape) {
    case 'box': {
      const dx = f.dx ?? 80, dy = f.dy ?? 40, dz = f.dz ?? 80
      const m = Manifold.cube([dx, dy, dz], true)
      const out = m.translate(0, dy / 2, 0)
      m.delete()
      return out
    }
    case 'cylinder': case 'cone': {
      const r = f.r ?? 30, h = f.h ?? (f.shape === 'cone' ? 70 : 60)
      const m = Manifold.cylinder(h, r, f.shape === 'cone' ? 0 : r, 96)
      const out = m.rotate(-90, 0, 0)
      m.delete()
      return out
    }
    case 'sphere': {
      const r = f.r ?? 35
      const m = Manifold.sphere(r, 64)
      const out = m.translate(0, r, 0)
      m.delete()
      return out
    }
    case 'torus': {
      const R = f.r ?? 45, r2 = Math.min(f.r2 ?? 12, R - 0.5)
      const circle = CrossSection.circle(r2, 48)
      const ring = circle.translate(R, 0)
      const rev = Manifold.revolve(ring, 96)
      const out0 = rev.rotate(-90, 0, 0)
      const out = out0.translate(0, r2, 0)
      circle.delete(); ring.delete(); rev.delete(); out0.delete()
      return out
    }
  }
}

// ---- Rigid transform (move/rotate gizmo) --------------------------------------
/** Apply a feature's pos/rot to a Manifold (returns a new one), matching the
 *  Object3D order: rotation first, then translation. */
export function transformSolid(m: Manifold, pos?: Vec3Tuple, rot?: Vec3Tuple): Manifold {
  let cur = m
  if (rot && (rot[0] || rot[1] || rot[2])) {
    const deg = 180 / Math.PI
    const r = cur.rotate(rot[0] * deg, rot[1] * deg, rot[2] * deg)
    if (cur !== m) cur.delete()
    cur = r
  }
  if (pos && (pos[0] || pos[1] || pos[2])) {
    const t = cur.translate(pos[0], pos[1], pos[2])
    if (cur !== m) cur.delete()
    cur = t
  }
  return cur
}
