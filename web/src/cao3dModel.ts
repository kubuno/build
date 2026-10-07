import type { Vec2 } from './geometry'
import { uid } from './util'

// CAO3D document model v2 — a parametric feature history, FreeCAD-style.
// The document is an ordered list of *features*; each feature owns typed,
// re-editable parameters and references earlier features by id (a DAG plunged
// into a linear timeline). Nothing is destructive any more: a pad references
// its sketch (which stays alive and editable), a combine references its solid
// operands (hidden while consumed, restored if the combine is deleted).
// Recompute (cao3dRecompute.ts) replays the timeline in order.

// ---- Sketch entities (2D, on the sketch plane) -----------------------------
// rect/poly are quick unconstrained primitives (home-tab tools); point/segment/
// arc/circle are the solver-grade entities used by the sketch editor, wired to
// planegcs through the sketch's constraint list.
export type SketchEntity =
  | { id: string; kind: 'rect'; a: Vec2; b: Vec2 }
  | { id: string; kind: 'circle'; c: Vec2; r: number }
  | { id: string; kind: 'poly'; pts: Vec2[]; closed: boolean }
  | { id: string; kind: 'point'; p: Vec2 }
  | { id: string; kind: 'segment'; a: Vec2; b: Vec2 }
  /** Circular arc, CCW from a0 to a1 (radians, sketch space). */
  | { id: string; kind: 'arc'; c: Vec2; r: number; a0: number; a1: number }

// ---- Sketch constraints (solved by planegcs, FreeCAD's Sketcher solver) -----
export type ConstraintKind =
  // geometric
  | 'coincident' | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular'
  | 'tangent' | 'equal' | 'pointOn'
  // dimensional (driving; `value` in mm, degrees for angle)
  | 'distance' | 'radius' | 'angle'

/** Anchor of a constraint: an entity, optionally one of its named points. */
export interface ConstraintRef {
  entity: string
  point?: 'a' | 'b' | 'center' | 'start' | 'end' | 'p'
}

export interface SketchConstraint {
  id: string
  kind: ConstraintKind
  refs: ConstraintRef[]
  value?: number
}

export type BooleanOp = 'union' | 'subtract' | 'intersect'
export interface EdgeMod { kind: 'fillet' | 'chamfer'; radius: number }
export type Vec3Tuple = [number, number, number]

// ---- Features ---------------------------------------------------------------
export interface FeatureBase {
  id: string
  /** User-visible label (« Esquisse 1 », « Extrusion 2 »…), renameable. */
  name: string
  /** Suppressed features are skipped by recompute (FreeCAD-style). */
  suppressed?: boolean
}

/** Where a sketch lives: the ground (XZ), the origin planes (XY front /
 *  YZ side) with an optional offset along their normal, or a planar face of a
 *  solid captured at pick time (origin + normal + in-plane x axis; `feature`
 *  records provenance — the plane is a static snapshot, not re-anchored). */
export type SketchPlane =
  | { kind: 'ground'; offset?: number }
  | { kind: 'xy'; offset?: number }
  | { kind: 'yz'; offset?: number }
  | { kind: 'face'; origin: Vec3Tuple; normal: Vec3Tuple; xAxis: Vec3Tuple; feature?: string }

export interface SketchFeature extends FeatureBase {
  type: 'sketch'
  plane: SketchPlane
  entities: SketchEntity[]
  constraints?: SketchConstraint[]
}

/** Rigid transform written by the move/rotate gizmos, shared by all solids. */
export interface SolidBase extends FeatureBase {
  pos?: Vec3Tuple // translation, mm
  rot?: Vec3Tuple // Euler XYZ, radians
}

export interface PadFeature extends SolidBase {
  type: 'pad'
  sketch: string // sketch feature id
  height: number // mm
  edgeMod?: EdgeMod
}

export interface RevolveFeature extends SolidBase {
  type: 'revolve'
  sketch: string
  angleDeg: number
}

export interface LoftFeature extends SolidBase {
  type: 'loft'
  sketchA: string
  sketchB: string
  height: number
}

export interface CombineFeature extends SolidBase {
  type: 'combine'
  operation: BooleanOp
  /** Solid feature ids, first = base. Order matters for subtract. */
  targets: string[]
}

/** Subtractive extrusion: digs `height` mm into `target` from the sketch
 *  plane (FreeCAD's Pocket). The target is consumed but stays editable. */
export interface PocketFeature extends SolidBase {
  type: 'pocket'
  sketch: string
  height: number
  target: string
}

/** Subtractive revolution around the sketch X axis (FreeCAD's Groove). */
export interface GrooveFeature extends SolidBase {
  type: 'groove'
  sketch: string
  angleDeg: number
  target: string
}

export type PrimitiveShape = 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus'

/** Parametric primitive resting on the ground (dimensions in mm):
 *  box = dx×dz footprint × dy height; cylinder/cone = r×h; sphere = r;
 *  torus = ring radius r + tube radius r2. */
export interface PrimitiveFeature extends SolidBase {
  type: 'primitive'
  shape: PrimitiveShape
  dx?: number
  dy?: number
  dz?: number
  r?: number
  r2?: number
  h?: number
}

/** Mirrored copy fused with the original, across the plane through the origin
 *  whose normal is `axis` (x = YZ plane, z = XY plane). */
export interface MirrorFeature extends SolidBase {
  type: 'mirror'
  target: string
  axis: 'x' | 'z'
}

/** Linear/polar repetition of a solid, all occurrences fused. Linear: `count`
 *  copies every `spacing` mm along `axis`; polar: spread over `angleDeg`
 *  around the world vertical through the origin. */
export interface PatternFeature extends SolidBase {
  type: 'pattern'
  target: string
  mode: 'linear' | 'polar'
  count: number
  spacing?: number
  axis?: 'x' | 'z'
  angleDeg?: number
}

export type Feature =
  | SketchFeature | PadFeature | RevolveFeature | LoftFeature | CombineFeature
  | PocketFeature | GrooveFeature | PrimitiveFeature | MirrorFeature | PatternFeature
export type SolidFeature = Exclude<Feature, SketchFeature>
export type FeatureType = Feature['type']

export const isSolidFeature = (f: Feature): f is SolidFeature => f.type !== 'sketch'

export interface CaoModel {
  version: 2
  features: Feature[]
  /** Rollback marker: last feature recomputed (null = whole timeline). */
  tip: string | null
  /** Per-type counters feeding the auto names. */
  seq: Partial<Record<FeatureType, number>>
  defaults: {
    extrudeHeight: number
    revolveAngle: number
  }
}

export function emptyCaoModel(): CaoModel {
  return {
    version: 2,
    features: [],
    tip: null,
    seq: {},
    defaults: { extrudeHeight: 40, revolveAngle: 360 },
  }
}

// ---- Typed feature parameters (FreeCAD property system, in miniature) -------
// Each feature type declares its editable numeric parameters. The properties
// panel and the timeline editor are both derived from these specs — no
// per-feature UI code.
export interface FeaturePropSpec {
  key: string
  /** i18n key (build namespace); the UI resolves it with a French fallback. */
  labelKey: string
  labelFallback: string
  kind: 'length' | 'angle' | 'count'
  min?: number
}

const L = (key: string, labelKey: string, fb: string, min = 1): FeaturePropSpec =>
  ({ key, labelKey, labelFallback: fb, kind: 'length', min })
const A = (key: string, labelKey: string, fb: string): FeaturePropSpec =>
  ({ key, labelKey, labelFallback: fb, kind: 'angle', min: 1 })
const N = (key: string, labelKey: string, fb: string, min = 1): FeaturePropSpec =>
  ({ key, labelKey, labelFallback: fb, kind: 'count', min })

export const FEATURE_PROPS: Record<FeatureType, FeaturePropSpec[]> = {
  sketch: [],
  pad: [L('height', 'cao_height', 'Hauteur')],
  revolve: [A('angle', 'cao_angle', 'Angle')],
  loft: [L('height', 'cao_height', 'Hauteur')],
  combine: [],
  pocket: [L('height', 'cao_depth', 'Profondeur')],
  groove: [A('angle', 'cao_angle', 'Angle')],
  primitive: [], // per-shape, resolved by primitiveProps()
  mirror: [],
  pattern: [N('count', 'cao_count', 'Nombre', 2)],
}

/** Dimension specs of a primitive, per shape. */
export function primitiveProps(shape: PrimitiveShape): FeaturePropSpec[] {
  switch (shape) {
    case 'box': return [L('dx', 'cao_width', 'Largeur'), L('dz', 'cao_depth', 'Profondeur'), L('dy', 'cao_height', 'Hauteur')]
    case 'cylinder': case 'cone': return [L('r', 'cao_radius', 'Rayon'), L('h', 'cao_height', 'Hauteur')]
    case 'sphere': return [L('r', 'cao_radius', 'Rayon')]
    case 'torus': return [L('r', 'cao_radius', 'Rayon'), L('r2', 'cao_tube', 'Tube')]
  }
}

/** Read a spec'd parameter off a feature (mm or degrees). */
export function getFeatureProp(f: Feature, key: string): number | null {
  switch (key) {
    case 'height': return f.type === 'pad' || f.type === 'loft' || f.type === 'pocket' ? f.height : null
    case 'angle': return f.type === 'revolve' || f.type === 'groove' ? f.angleDeg : null
    case 'radius': return f.type === 'pad' && f.edgeMod ? f.edgeMod.radius : null
    case 'count': return f.type === 'pattern' ? f.count : null
    case 'spacing': return f.type === 'pattern' ? f.spacing ?? 0 : null
    case 'pangle': return f.type === 'pattern' ? f.angleDeg ?? 360 : null
    case 'dx': case 'dy': case 'dz': case 'r': case 'r2': case 'h':
      return f.type === 'primitive' ? f[key] ?? null : null
    default: return null
  }
}

/** Write a spec'd parameter (value already in mm / degrees). */
export function setFeatureProp(f: Feature, key: string, value: number): boolean {
  if (key === 'height' && (f.type === 'pad' || f.type === 'loft' || f.type === 'pocket')) { f.height = Math.max(1, value); return true }
  if (key === 'angle' && (f.type === 'revolve' || f.type === 'groove')) { f.angleDeg = Math.max(1, Math.min(360, value)); return true }
  if (key === 'radius' && f.type === 'pad' && f.edgeMod) { f.edgeMod.radius = Math.max(0, value); return true }
  if (f.type === 'pattern') {
    if (key === 'count') { f.count = Math.max(2, Math.round(value)); return true }
    if (key === 'spacing') { f.spacing = Math.max(1, value); return true }
    if (key === 'pangle') { f.angleDeg = Math.max(1, Math.min(360, value)); return true }
  }
  if (f.type === 'primitive' && ['dx', 'dy', 'dz', 'r', 'r2', 'h'].includes(key)) {
    f[key as 'dx'] = Math.max(0.5, value)
    return true
  }
  return false
}

/** Next auto name for a feature type (« Extrusion 3 »). Mutates the counter. */
export function nextName(model: CaoModel, type: FeatureType, prefix: string): string {
  const n = (model.seq[type] ?? 0) + 1
  model.seq[type] = n
  return `${prefix} ${n}`
}

/** Feature ids referenced by `f` (its DAG parents). */
export function featureRefs(f: Feature): string[] {
  switch (f.type) {
    case 'pad': case 'revolve': return [f.sketch]
    case 'loft': return [f.sketchA, f.sketchB]
    case 'combine': return f.targets
    case 'pocket': case 'groove': return [f.sketch, f.target]
    case 'mirror': case 'pattern': return [f.target]
    default: return []
  }
}

/** Ids of every feature that (transitively) depends on `id` — used for cascade
 *  delete: removing a sketch removes its pads, then the combines above them. */
export function dependentsOf(model: CaoModel, id: string): Set<string> {
  const doomed = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const f of model.features) {
      if (doomed.has(f.id)) continue
      const refs = featureRefs(f)
      if (refs.some(r => doomed.has(r))) { doomed.add(f.id); grew = true }
    }
  }
  doomed.delete(id)
  return doomed
}

export function isClosedEntity(e: SketchEntity): boolean {
  return e.kind === 'rect' || e.kind === 'circle' || (e.kind === 'poly' && e.closed && e.pts.length >= 3)
}

/** Endpoint-chaining tolerance (mm) when assembling segment/arc loops. */
export const CHAIN_TOL = 0.5

const near = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y) <= CHAIN_TOL

/** Sample an arc CCW from a0 to a1 (radians), endpoints included. */
export function arcPoints(e: { c: Vec2; r: number; a0: number; a1: number }, segs = 32): Vec2[] {
  let sweep = e.a1 - e.a0
  while (sweep <= 0) sweep += Math.PI * 2
  const pts: Vec2[] = []
  for (let i = 0; i <= segs; i++) {
    const t = e.a0 + (i / segs) * sweep
    pts.push({ x: e.c.x + Math.cos(t) * e.r, y: e.c.y + Math.sin(t) * e.r })
  }
  return pts
}

/** Closed profile loops of a sketch: closed primitives as-is, plus loops chained
 *  from segments/arcs by endpoint proximity (coincident-constrained endpoints
 *  are exact; CHAIN_TOL covers hand-drawn ones). Loops come back as synthetic
 *  closed polys so downstream feature builders need no new cases. */
export function sketchLoops(f: SketchFeature): SketchEntity[] {
  const loops: SketchEntity[] = f.entities.filter(isClosedEntity)
  type Edge = { pts: Vec2[]; used: boolean }
  const edges: Edge[] = []
  for (const e of f.entities) {
    if (e.kind === 'segment') edges.push({ pts: [e.a, e.b], used: false })
    else if (e.kind === 'arc') edges.push({ pts: arcPoints(e), used: false })
  }
  for (const start of edges) {
    if (start.used) continue
    start.used = true
    const chain = start.pts.slice()
    let extended = true
    while (extended && !near(chain[0], chain[chain.length - 1])) {
      extended = false
      const tail = chain[chain.length - 1]
      for (const e of edges) {
        if (e.used) continue
        if (near(e.pts[0], tail)) { chain.push(...e.pts.slice(1)); e.used = true; extended = true; break }
        if (near(e.pts[e.pts.length - 1], tail)) { chain.push(...e.pts.slice(0, -1).reverse()); e.used = true; extended = true; break }
      }
    }
    if (chain.length >= 4 && near(chain[0], chain[chain.length - 1])) {
      loops.push({ id: `${f.id}:loop${loops.length}`, kind: 'poly', pts: chain.slice(0, -1), closed: true })
    }
  }
  return loops
}

/** A sketch usable by pad/revolve/loft: at least one closed profile loop. */
export function sketchIsClosed(f: SketchFeature): boolean {
  return sketchLoops(f).length > 0
}

// ---- Validation (tolerant loader) -------------------------------------------
const isVec2 = (p: unknown): p is Vec2 =>
  !!p && typeof (p as Vec2).x === 'number' && typeof (p as Vec2).y === 'number'

function isEntity(p: unknown): p is SketchEntity {
  if (!p || typeof (p as SketchEntity).id !== 'string') return false
  const v = p as SketchEntity
  if (v.kind === 'rect') return isVec2(v.a) && isVec2(v.b)
  if (v.kind === 'circle') return isVec2(v.c) && typeof v.r === 'number'
  if (v.kind === 'poly') return Array.isArray(v.pts) && v.pts.length >= 2 && v.pts.every(isVec2)
  if (v.kind === 'point') return isVec2(v.p)
  if (v.kind === 'segment') return isVec2(v.a) && isVec2(v.b)
  if (v.kind === 'arc') return isVec2(v.c) && typeof v.r === 'number' && typeof v.a0 === 'number' && typeof v.a1 === 'number'
  return false
}

function isConstraint(c: unknown): c is SketchConstraint {
  if (!c || typeof (c as SketchConstraint).id !== 'string') return false
  const v = c as SketchConstraint
  return typeof v.kind === 'string' && Array.isArray(v.refs)
    && v.refs.every(r => r && typeof r.entity === 'string')
}

const isVec3Tuple = (v: unknown): v is Vec3Tuple =>
  Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number')

function isFeature(f: unknown): f is Feature {
  if (!f || typeof (f as Feature).id !== 'string' || typeof (f as Feature).name !== 'string') return false
  const v = f as Feature
  if (isSolidFeature(v as Feature)) {
    const s = v as SolidFeature
    if (s.pos != null && !isVec3Tuple(s.pos)) return false
    if (s.rot != null && !isVec3Tuple(s.rot)) return false
  }
  switch (v.type) {
    case 'sketch': {
      if (!Array.isArray(v.entities) || !v.entities.every(isEntity)) return false
      // Tolerate a missing/malformed plane by resetting it to the ground.
      const p = v.plane as SketchPlane | undefined
      const okPlane = !!p && (
        ((p.kind === 'ground' || p.kind === 'xy' || p.kind === 'yz') && (p.offset == null || typeof p.offset === 'number'))
        || (p.kind === 'face' && isVec3Tuple(p.origin) && isVec3Tuple(p.normal) && isVec3Tuple(p.xAxis))
      )
      if (!okPlane) (v as SketchFeature).plane = { kind: 'ground' }
      return true
    }
    case 'pad': return typeof v.sketch === 'string' && typeof v.height === 'number'
    case 'revolve': return typeof v.sketch === 'string' && typeof v.angleDeg === 'number'
    case 'loft': return typeof v.sketchA === 'string' && typeof v.sketchB === 'string' && typeof v.height === 'number'
    case 'combine': return Array.isArray(v.targets) && v.targets.every(t => typeof t === 'string')
    case 'pocket': return typeof v.sketch === 'string' && typeof v.target === 'string' && typeof v.height === 'number'
    case 'groove': return typeof v.sketch === 'string' && typeof v.target === 'string' && typeof v.angleDeg === 'number'
    case 'primitive': return ['box', 'cylinder', 'sphere', 'cone', 'torus'].includes(v.shape)
    case 'mirror': return typeof v.target === 'string' && (v.axis === 'x' || v.axis === 'z')
    case 'pattern': return typeof v.target === 'string' && (v.mode === 'linear' || v.mode === 'polar') && typeof v.count === 'number'
    default: return false
  }
}

// ---- v1 migration ------------------------------------------------------------
// v1 was a destructive model: flat profiles[] + bodies[] where booleans embedded
// deep clones of their operands. We unfold it into a feature timeline: every
// embedded profile becomes a sketch feature, every body a solid feature, boolean
// operands are materialized as real (consumed) features.
interface V1Profile { id: string; kind: 'rect' | 'circle' | 'poly'; [k: string]: unknown }
interface V1Body {
  id: string
  op: 'extrude' | 'revolve' | 'loft' | 'boolean'
  profile?: V1Profile
  profileB?: V1Profile
  height?: number
  angleDeg?: number
  edgeMod?: EdgeMod
  operands?: V1Body[]
  operation?: BooleanOp
  pos?: Vec3Tuple
  rot?: Vec3Tuple
}

function looksLikeV1(d: Record<string, unknown>): boolean {
  return d.version === 1 || (Array.isArray(d.profiles) || Array.isArray(d.bodies)) && !Array.isArray(d.features)
}

function migrateV1(d: Record<string, unknown>): CaoModel {
  const model = emptyCaoModel()
  const oldDefaults = d.defaults as CaoModel['defaults'] | undefined
  if (oldDefaults) model.defaults = { ...model.defaults, ...oldDefaults }

  const addSketch = (entity: SketchEntity): string => {
    const id = uid('f')
    model.features.push({
      id, type: 'sketch', name: nextName(model, 'sketch', 'Esquisse'),
      plane: { kind: 'ground' }, entities: [entity],
    })
    return id
  }

  const addBody = (b: V1Body): string | null => {
    const base = { id: uid('f'), pos: b.pos, rot: b.rot }
    if (b.op === 'boolean') {
      const targets = (b.operands ?? []).map(addBody).filter((x): x is string => !!x)
      if (targets.length < 2) return targets[0] ?? null
      model.features.push({
        ...base, type: 'combine', name: nextName(model, 'combine', 'Combinaison'),
        operation: b.operation ?? 'union', targets,
      })
      return base.id
    }
    if (!b.profile || !isEntity(b.profile)) return null
    const sketch = addSketch({ ...(b.profile as SketchEntity), id: uid('e') })
    if (b.op === 'revolve') {
      model.features.push({
        ...base, type: 'revolve', name: nextName(model, 'revolve', 'Révolution'),
        sketch, angleDeg: b.angleDeg ?? 360,
      })
    } else if (b.op === 'loft' && b.profileB && isEntity(b.profileB)) {
      const sketchB = addSketch({ ...(b.profileB as SketchEntity), id: uid('e') })
      model.features.push({
        ...base, type: 'loft', name: nextName(model, 'loft', 'Lissage'),
        sketchA: sketch, sketchB, height: b.height ?? 40,
      })
    } else {
      model.features.push({
        ...base, type: 'pad', name: nextName(model, 'pad', 'Extrusion'),
        sketch, height: b.height ?? 40, edgeMod: b.edgeMod,
      })
    }
    return base.id
  }

  if (Array.isArray(d.bodies)) for (const b of d.bodies as V1Body[]) addBody(b)
  // Free-standing v1 profiles (not yet extruded) become plain sketches.
  if (Array.isArray(d.profiles)) {
    for (const p of d.profiles as V1Profile[]) {
      if (isEntity(p)) addSketch(p as SketchEntity)
    }
  }
  return model
}

// ---- Loader -------------------------------------------------------------------
// Tolerant: drop malformed features (hand-edited/corrupted .kbcao files must
// degrade, not crash); dangling references are kept and flagged by recompute.
export function loadCaoModel(data: unknown): CaoModel {
  const base = emptyCaoModel()
  if (!data || typeof data !== 'object') return base
  const d = data as Record<string, unknown>
  if (looksLikeV1(d)) return migrateV1(d)
  const m = d as Partial<CaoModel>
  const features = Array.isArray(m.features) ? m.features.filter(isFeature) : []
  // Sanitize sketch constraints: drop malformed ones and those referencing
  // entities that no longer exist (hand-edited files must degrade gracefully).
  for (const f of features) {
    if (f.type !== 'sketch' || !f.constraints) continue
    const eids = new Set(f.entities.map(e => e.id))
    f.constraints = f.constraints.filter(c => isConstraint(c) && c.refs.every(r => eids.has(r.entity)))
    if (!f.constraints.length) delete f.constraints
  }
  const ids = new Set(features.map(f => f.id))
  return {
    version: 2,
    features,
    tip: typeof m.tip === 'string' && ids.has(m.tip) ? m.tip : null,
    seq: m.seq && typeof m.seq === 'object' ? m.seq : {},
    defaults: { ...base.defaults, ...(m.defaults ?? {}) },
  }
}
