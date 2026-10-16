import type { Vec2 } from './geometry'
import type { ArchBuilding, ArchRoad, BuildingStyle, RoofType } from './architectModel'
import { uid } from './util'

// Procedural generation for Architect: a small, deterministic (seeded) toolbox
// that emits building volumes, bridges and whole city grids. Everything metric
// (mm). A seed makes a layout reproducible; bump it to reroll.

/** mulberry32 - tiny deterministic PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Rect { x0: number; z0: number; x1: number; z1: number }

export function boundingRect(pts: Vec2[]): Rect {
  const xs = pts.map(p => p.x), zs = pts.map(p => p.y)
  return { x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) }
}

export function rectPoly(r: Rect): Vec2[] {
  return [{ x: r.x0, y: r.z0 }, { x: r.x1, y: r.z0 }, { x: r.x1, y: r.z1 }, { x: r.x0, y: r.z1 }]
}

export function inset(r: Rect, m: number): Rect {
  return { x0: r.x0 + m, z0: r.z0 + m, x1: r.x1 - m, z1: r.z1 - m }
}

/** A single procedural building over a footprint. */
export function makeBuilding(footprint: Vec2[], opts: {
  floors: number; floorHeight: number; style: BuildingStyle; seed: number; roof?: RoofType | 'none'; base?: number
}): ArchBuilding {
  return {
    id: uid('bld'),
    footprint: footprint.map(p => ({ ...p })),
    base: opts.base ?? 0,
    floors: Math.max(1, Math.round(opts.floors)),
    floorHeight: opts.floorHeight,
    style: opts.style,
    seed: opts.seed,
    roof: opts.roof ?? 'none',
  }
}

export interface CityOptions {
  seed: number
  cols: number
  rows: number
  block: number       // block size (mm)
  roadWidth: number
  floorHeight: number
  maxFloors: number   // tallest tower at the centre
  center: Vec2
}

export function defaultCityOptions(seed: number, center: Vec2): CityOptions {
  return { seed, cols: 5, rows: 5, block: 22000, roadWidth: 6000, floorHeight: 3400, maxFloors: 48, center }
}

/** A downtown-style grid: streets between blocks, one procedural building per
 *  block. Heights fall off from a tall centre (skyscrapers) to low edges. */
export function generateCity(o: CityOptions): { roads: ArchRoad[]; buildings: ArchBuilding[] } {
  const rand = rng(o.seed)
  const step = o.block + o.roadWidth
  const w = o.cols * step, h = o.rows * step
  const ox = o.center.x - w / 2, oz = o.center.y - h / 2
  const roads: ArchRoad[] = []
  const buildings: ArchBuilding[] = []

  // Street grid (roads run along block boundaries).
  for (let i = 0; i <= o.cols; i++) {
    const x = ox + i * step + o.roadWidth / 2
    roads.push({ id: uid('r'), path: [{ x, y: oz }, { x, y: oz + h }], width: o.roadWidth })
  }
  for (let j = 0; j <= o.rows; j++) {
    const z = oz + j * step + o.roadWidth / 2
    roads.push({ id: uid('r'), path: [{ x: ox, y: z }, { x: ox + w, y: z }], width: o.roadWidth })
  }

  const cx = (o.cols - 1) / 2, cz = (o.rows - 1) / 2
  const maxDist = Math.hypot(cx, cz) || 1
  for (let i = 0; i < o.cols; i++) {
    for (let j = 0; j < o.rows; j++) {
      const bx0 = ox + i * step + o.roadWidth
      const bz0 = oz + j * step + o.roadWidth
      const rect: Rect = { x0: bx0, z0: bz0, x1: bx0 + o.block, z1: bz0 + o.block }
      const margin = 1500 + rand() * 2500
      const fp = inset(rect, margin)
      // Height: central falloff + noise → tall towers downtown, low at edges.
      const dist = Math.hypot(i - cx, j - cz) / maxDist
      const centrality = 1 - dist
      const floors = Math.max(2, Math.round((3 + centrality * o.maxFloors) * (0.55 + rand() * 0.6)))
      const style: BuildingStyle = floors > 22 ? (rand() > 0.5 ? 'setback' : 'taper') : 'flat'
      const roof: RoofType | 'none' = floors <= 3 && rand() > 0.5 ? 'gable' : 'none'
      buildings.push(makeBuilding(rectPoly(fp), { floors, floorHeight: o.floorHeight, style, seed: (o.seed * 131 + i * 37 + j * 17) >>> 0, roof }))
    }
  }
  return { roads, buildings }
}
