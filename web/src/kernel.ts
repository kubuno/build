import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import Module from 'manifold-3d'
import type { Manifold, ManifoldToplevel, SimplePolygon } from 'manifold-3d'
import wasmUrl from 'manifold-3d/manifold.wasm?url'
import type { Vec2 } from './geometry'

// Geometry kernel for CAO3D, backed by Manifold (manifold-3d WASM). Manifold
// guarantees topologically valid (watertight, oriented) solids through boolean
// operations and traces face provenance (runOriginalID), which is the basis of
// our stable face naming - the lesson learned from FreeCAD's fifteen years of
// topological-naming pain: bake provenance in from day one.
//
// Conventions: Manifold builds solids Z-up from XY polygons; our world is Y-up
// with sketch Vec2 {x,y} mapping to world (x, 0, y). Helpers here convert.

let M: ManifoldToplevel | null = null
let initPromise: Promise<void> | null = null

/** Load + set up the Manifold WASM once. Editors await this before building. */
export function initKernel(): Promise<void> {
  if (!initPromise) {
    initPromise = Module({ locateFile: () => wasmUrl }).then(m => {
      m.setup()
      M = m
    })
  }
  return initPromise
}

/** The initialized toplevel; throws if initKernel() has not resolved yet. */
export function kernel(): ManifoldToplevel {
  if (!M) throw new Error('Manifold kernel not initialized')
  return M
}

// ---- Polygon helpers -------------------------------------------------------
/** Sketch-space Vec2 outline → Manifold XY polygon, CCW enforced. The y is
 *  negated so the +Z extrusion, once rotated onto the ground (rotateX -90°),
 *  restores Vec2.y → world z (same trick as the old THREE.Shape path). */
export function toPolygon(pts: Vec2[]): SimplePolygon {
  const poly: SimplePolygon = pts.map(p => [p.x, -p.y] as [number, number])
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]
    const [bx, by] = poly[(i + 1) % poly.length]
    area += ax * by - bx * ay
  }
  if (area < 0) poly.reverse()
  return poly
}

/** Extrude an XY polygon by `height` and lay it on the ground plane (+Y up). */
export function extrudePolygon(pts: Vec2[], height: number): Manifold {
  const m = kernel().Manifold.extrude(toPolygon(pts), height)
  const out = m.rotate(-90, 0, 0)
  m.delete()
  return out
}

/** Revolve a sketch outline around the sketch X axis by `angleDeg` degrees.
 *  Matches the legacy lathe: radius = |Vec2.y|, axis position = Vec2.x. */
export function revolvePolygon(pts: Vec2[], angleDeg: number, segments = 96): Manifold {
  // Manifold revolves an XY polygon around Y (keeping x ≥ 0) with the revolve
  // axis becoming Z. Map: polygon x = radius, polygon y = position along axis.
  const poly: SimplePolygon = pts.map(p => [Math.max(0.001, Math.abs(p.y)), p.x] as [number, number])
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]
    const [bx, by] = poly[(i + 1) % poly.length]
    area += ax * by - bx * ay
  }
  if (area < 0) poly.reverse()
  const m = kernel().Manifold.revolve(poly, segments, Math.max(1, Math.min(360, angleDeg)))
  // Revolve axis (Z) → world X, radius spreading in world Y/Z like the old lathe.
  const out = m.rotate(0, 90, 0)
  m.delete()
  return out
}

// ---- three.js ↔ Manifold bridges ------------------------------------------
/** Convert a three.js geometry (custom lofts, filleted primitives…) into a
 *  Manifold. Positions are welded first; throws if the shell is not watertight. */
export function manifoldFromGeometry(geo: THREE.BufferGeometry, originalID?: number): Manifold {
  const { Mesh, Manifold } = kernel()
  // Weld by position only: drop shading attributes so mergeVertices can unify
  // seam vertices (caps/walls are emitted separately by THREE generators).
  let src = geo.clone()
  for (const name of Object.keys(src.attributes)) {
    if (name !== 'position') src.deleteAttribute(name)
  }
  src = mergeVertices(src)
  const pos = src.getAttribute('position')
  const index = src.getIndex()
  const vertProperties = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    vertProperties[i * 3] = pos.getX(i)
    vertProperties[i * 3 + 1] = pos.getY(i)
    vertProperties[i * 3 + 2] = pos.getZ(i)
  }
  const triVerts = index
    ? new Uint32Array(index.array)
    : new Uint32Array(Array.from({ length: pos.count }, (_, i) => i))
  const mesh = new Mesh({
    numProp: 3,
    vertProperties,
    triVerts,
    ...(originalID != null ? {
      runIndex: new Uint32Array([0, triVerts.length]),
      runOriginalID: new Uint32Array([originalID]),
    } : {}),
  })
  mesh.merge() // fill merge vectors for verts sharing a position
  const out = Manifold.ofMesh(mesh)
  src.dispose()
  return out
}

export interface FaceRun {
  /** Provenance: the reserved originalID of the source feature's mesh. */
  originalID: number
  /** First triangle index (in the index buffer) and triangle count. */
  start: number
  count: number
}

/** Extract a display BufferGeometry (with CAD-style normals: smooth walls,
 *  sharp creases over 30°) plus face-provenance runs from a Manifold. */
export function geometryFromManifold(m: Manifold): { geometry: THREE.BufferGeometry; runs: FaceRun[] } {
  const withNormals = m.calculateNormals(0, 30)
  const mesh = withNormals.getMesh(0)
  withNormals.delete()
  const np = mesh.numProp
  const vertCount = mesh.vertProperties.length / np
  const positions = new Float32Array(vertCount * 3)
  const normals = new Float32Array(vertCount * 3)
  for (let i = 0; i < vertCount; i++) {
    positions[i * 3] = mesh.vertProperties[i * np]
    positions[i * 3 + 1] = mesh.vertProperties[i * np + 1]
    positions[i * 3 + 2] = mesh.vertProperties[i * np + 2]
    normals[i * 3] = mesh.vertProperties[i * np + 3]
    normals[i * 3 + 1] = mesh.vertProperties[i * np + 4]
    normals[i * 3 + 2] = mesh.vertProperties[i * np + 5]
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.triVerts), 1))
  const runs: FaceRun[] = []
  if (mesh.runOriginalID && mesh.runIndex) {
    for (let i = 0; i < mesh.runOriginalID.length; i++) {
      const start = mesh.runIndex[i]
      const end = mesh.runIndex[i + 1] ?? mesh.triVerts.length
      runs.push({ originalID: mesh.runOriginalID[i], start, count: (end - start) / 3 })
    }
  }
  return { geometry, runs }
}
