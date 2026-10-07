import * as THREE from 'three'
import type { Vec2 } from './geometry'
import type { SketchPlane, Vec3Tuple } from './cao3dModel'

// Sketch-plane geometry: every sketch lives on a plane described by an origin,
// a normal and an in-plane x axis; the in-plane y axis is x × normal, which
// keeps the ground-plane mapping identical to the legacy convention
// (Vec2 {x,y} → world (x, 0, y)) and guarantees a right-handed frame — solids
// built in "ground space" and transformed onto the plane keep their winding
// (a mirrored frame would turn Manifold solids inside out).

export interface PlaneBasis {
  origin: THREE.Vector3
  x: THREE.Vector3
  y: THREE.Vector3
  normal: THREE.Vector3
}

const v3 = (t: Vec3Tuple) => new THREE.Vector3(t[0], t[1], t[2])

function makeBasis(origin: THREE.Vector3, normal: THREE.Vector3, x: THREE.Vector3): PlaneBasis {
  const n = normal.clone().normalize()
  const xn = x.clone().sub(n.clone().multiplyScalar(x.dot(n))).normalize()
  const y = xn.clone().cross(n) // right-handed [x, n, y]
  return { origin: origin.clone(), x: xn, y, normal: n }
}

export function planeBasis(plane: SketchPlane): PlaneBasis {
  switch (plane.kind) {
    case 'ground':
      return makeBasis(new THREE.Vector3(0, plane.offset ?? 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0))
    case 'xy': // front plane; sketch y ends up world -y, camera up compensates
      return makeBasis(new THREE.Vector3(0, 0, plane.offset ?? 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0))
    case 'yz': // side plane; x = -z so the in-plane y comes out screen-friendly
      return makeBasis(new THREE.Vector3(plane.offset ?? 0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1))
    case 'face':
      return makeBasis(v3(plane.origin), v3(plane.normal), v3(plane.xAxis))
  }
}

export function toWorld(b: PlaneBasis, v: Vec2, lift = 0): THREE.Vector3 {
  return b.origin.clone()
    .addScaledVector(b.x, v.x)
    .addScaledVector(b.y, v.y)
    .addScaledVector(b.normal, lift)
}

export function fromWorld(b: PlaneBasis, w: THREE.Vector3): Vec2 {
  const d = w.clone().sub(b.origin)
  return { x: d.dot(b.x), y: d.dot(b.y) }
}

/** Intersect a world ray with the plane → sketch coordinates (null if parallel). */
export function intersectRay(b: PlaneBasis, ray: THREE.Ray): Vec2 | null {
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(b.normal, b.origin)
  const hit = new THREE.Vector3()
  if (!ray.intersectPlane(plane, hit)) return null
  return fromWorld(b, hit)
}

/** World transform mapping "ground space" (sketch x, height, sketch y) onto the
 *  plane — the matrix applied to Manifold solids built flat. Column-major
 *  elements are directly consumable by Manifold.transform(). */
export function planeMatrix(b: PlaneBasis): THREE.Matrix4 {
  return new THREE.Matrix4().makeBasis(b.x, b.normal, b.y).setPosition(b.origin)
}

/** True when the plane is the legacy ground plane at height 0 (identity). */
export function isGroundIdentity(plane: SketchPlane): boolean {
  return plane.kind === 'ground' && !(plane.offset ?? 0)
}

/** Build a serializable face plane from a raycast hit (point + world normal).
 *  The x axis is chosen horizontal when possible (stable, readable sketches).
 *  Captured statically — it does not re-anchor if the solid moves later. */
export function facePlaneFromHit(point: THREE.Vector3, normal: THREE.Vector3, feature?: string): SketchPlane {
  const n = normal.clone().normalize()
  const up = new THREE.Vector3(0, 1, 0)
  const x = Math.abs(n.dot(up)) > 0.92
    ? new THREE.Vector3(1, 0, 0).sub(n.clone().multiplyScalar(n.x)).normalize()
    : up.clone().cross(n).normalize()
  const t = (v: THREE.Vector3): Vec3Tuple => [v.x, v.y, v.z]
  return { kind: 'face', origin: t(point), normal: t(n), xAxis: t(x), feature }
}
