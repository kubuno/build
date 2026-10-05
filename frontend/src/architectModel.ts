import type { Vec2 } from './geometry'

// Architect document model. Everything metric (mm). A building is a set of wall
// segments (thick, with a height), optional floor slabs, openings that pierce a
// wall (doors/windows) and roads (flat ribbons on the ground). The 2D plan and
// the 3D elevation are the same geometry seen from two cameras.
export type OpeningKind = 'door' | 'window'

export interface ArchWall {
  id: string
  a: Vec2
  b: Vec2
  thickness: number
  height: number
}

export interface ArchSlab {
  id: string
  poly: Vec2[]
}

export interface ArchOpening {
  id: string
  wallId: string
  /** Position along the wall in [0,1]. */
  t: number
  width: number
  height: number
  /** Sill height for windows (0 for doors). */
  sill: number
  kind: OpeningKind
}

export interface ArchRoad {
  id: string
  path: Vec2[]
  width: number
}

export type RoofType = 'gable' | 'hip' | 'flat'

export interface ArchRoof {
  id: string
  /** Rectangular footprint (4 corners, CCW). */
  footprint: Vec2[]
  type: RoofType
  /** Base height (top of walls) in mm. */
  base: number
  /** Ridge rise above the base in mm. */
  rise: number
  /** Eaves overhang beyond the footprint in mm. */
  overhang: number
}

export type BuildingStyle = 'flat' | 'setback' | 'taper'

// Procedural building volume: a footprint rectangle extruded into stacked floors
// with a generated window facade. Covers multi-storey houses, mid-rises and
// skyscrapers (setback/taper give the tiered silhouette).
export interface ArchBuilding {
  id: string
  footprint: Vec2[]
  base: number
  floors: number
  floorHeight: number
  style: BuildingStyle
  seed: number
  roof: RoofType | 'none'
}

// Procedural bridge along a path: an elevated deck carried by piers, with
// optional arches spanning between them.
export interface ArchBridge {
  id: string
  path: Vec2[]
  width: number
  deckHeight: number // clearance from ground to underside of deck
  spans: number      // number of piers/arches
  arch: boolean
}

export interface ArchModel {
  version: 1
  walls: ArchWall[]
  slabs: ArchSlab[]
  openings: ArchOpening[]
  roads: ArchRoad[]
  roofs: ArchRoof[]
  buildings: ArchBuilding[]
  bridges: ArchBridge[]
  defaults: {
    wallThickness: number
    wallHeight: number
    doorWidth: number
    doorHeight: number
    windowWidth: number
    windowHeight: number
    windowSill: number
    roadWidth: number
    roofRise: number
    roofOverhang: number
    floors: number
    floorHeight: number
  }
}

export function emptyArchModel(): ArchModel {
  return {
    version: 1,
    walls: [],
    slabs: [],
    openings: [],
    roads: [],
    roofs: [],
    buildings: [],
    bridges: [],
    defaults: {
      wallThickness: 200,
      wallHeight: 2500,
      doorWidth: 900,
      doorHeight: 2100,
      windowWidth: 1200,
      windowHeight: 1000,
      windowSill: 900,
      roadWidth: 3000,
      roofRise: 1500,
      roofOverhang: 300,
      floors: 6,
      floorHeight: 3200,
    },
  }
}

const isVec2 = (p: unknown): p is Vec2 =>
  !!p && typeof (p as Vec2).x === 'number' && typeof (p as Vec2).y === 'number'
const isPoly = (pts: unknown, min: number): pts is Vec2[] =>
  Array.isArray(pts) && pts.length >= min && pts.every(isVec2)

// Tolerant loader: keep unknown fields out, drop malformed entities (files can
// be hand-edited or corrupted in drive) and fill defaults so older/partial
// docs still open instead of crashing the engine.
export function loadArchModel(data: unknown): ArchModel {
  const base = emptyArchModel()
  if (!data || typeof data !== 'object') return base
  const d = data as Partial<ArchModel>
  const arr = <T>(v: T[] | undefined, keep: (x: T) => boolean): T[] =>
    Array.isArray(v) ? v.filter(x => !!x && keep(x)) : []
  const walls = arr(d.walls, w => typeof w.id === 'string' && isVec2(w.a) && isVec2(w.b))
  const wallIds = new Set(walls.map(w => w.id))
  return {
    version: 1,
    walls,
    slabs: arr(d.slabs, s => typeof s.id === 'string' && isPoly(s.poly, 3)),
    openings: arr(d.openings, o => typeof o.id === 'string' && wallIds.has(o.wallId) && typeof o.t === 'number'),
    roads: arr(d.roads, r => typeof r.id === 'string' && isPoly(r.path, 2)),
    roofs: arr(d.roofs, r => typeof r.id === 'string' && isPoly(r.footprint, 3)),
    buildings: arr(d.buildings, b => typeof b.id === 'string' && isPoly(b.footprint, 3)),
    bridges: arr(d.bridges, b => typeof b.id === 'string' && isPoly(b.path, 2)),
    defaults: { ...base.defaults, ...(d.defaults ?? {}) },
  }
}
