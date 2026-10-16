import { init_planegcs_module, GcsWrapper } from '@salusoft89/planegcs'
import wasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url'
import type { Vec2 } from './geometry'
import type { ConstraintRef, SketchConstraint, SketchEntity, SketchFeature } from './cao3dModel'

// Bridge to planegcs - FreeCAD's 2D geometric constraint solver, compiled to
// WASM (@salusoft89/planegcs). Our sketch entities/constraints are converted to
// planegcs primitives, solved (DogLeg by default), and the solution is written
// back into entity copies. The solver also reports the remaining degrees of
// freedom and the conflicting/redundant constraints - the live feedback shown
// in the sketch editor, exactly like FreeCAD's Sketcher.

let wrapper: GcsWrapper | null = null
let initPromise: Promise<void> | null = null

// The emscripten artifact ships without type declarations - type its surface.
type PlanegcsInit = (opts?: { locateFile: () => string }) => Promise<{
  GcsSystem: new () => ConstructorParameters<typeof GcsWrapper>[0]
}>

export function initSketchSolver(): Promise<void> {
  if (initPromise) return initPromise
  const p = (init_planegcs_module as PlanegcsInit)({ locateFile: () => wasmUrl }).then(mod => {
    wrapper = new GcsWrapper(new mod.GcsSystem())
  })
  initPromise = p
  return p
}

export interface SolveOutcome {
  ok: boolean
  /** Remaining degrees of freedom (0 = fully constrained). */
  dof: number
  conflicting: string[]
  redundant: string[]
  /** Updated entities (same ids, solved coordinates) when ok. */
  entities: SketchEntity[]
}

export interface DragTarget {
  entity: string
  point: 'a' | 'b' | 'center' | 'start' | 'end' | 'p'
  x: number
  y: number
}

type Prim = Record<string, unknown>

const pt = (id: string, p: Vec2, fixed = false): Prim =>
  ({ id, type: 'point', x: p.x, y: p.y, fixed })

/** Solver id of a named point on an entity. */
function pointId(e: SketchEntity, role?: ConstraintRef['point']): string | null {
  switch (e.kind) {
    case 'point': return `${e.id}.p`
    case 'segment': return role === 'b' ? `${e.id}.b` : role === 'a' ? `${e.id}.a` : null
    case 'circle': return role === 'center' || role == null ? `${e.id}.c` : null
    case 'arc':
      return role === 'center' ? `${e.id}.c`
        : role === 'start' ? `${e.id}.s`
        : role === 'end' ? `${e.id}.e` : null
    default: return null
  }
}

/** Convert one of our constraints into planegcs primitives (or null = skip). */
function toGcs(c: SketchConstraint, byId: Map<string, SketchEntity>): Prim | null {
  const ent = (i: number) => byId.get(c.refs[i]?.entity) ?? null
  const p = (i: number) => {
    const e = ent(i)
    return e ? pointId(e, c.refs[i].point) : null
  }
  const e0 = ent(0), e1 = ent(1)
  const base = { id: c.id }
  switch (c.kind) {
    case 'coincident': {
      const a = p(0), b = p(1)
      return a && b ? { ...base, type: 'p2p_coincident', p1_id: a, p2_id: b } : null
    }
    case 'horizontal':
    case 'vertical': {
      const t = c.kind === 'horizontal' ? 'horizontal' : 'vertical'
      if (e0?.kind === 'segment' && c.refs.length === 1) return { ...base, type: `${t}_l`, l_id: e0.id }
      const a = p(0), b = p(1)
      return a && b ? { ...base, type: `${t}_pp`, p1_id: a, p2_id: b } : null
    }
    case 'parallel':
      return e0?.kind === 'segment' && e1?.kind === 'segment'
        ? { ...base, type: 'parallel', l1_id: e0.id, l2_id: e1.id } : null
    case 'perpendicular':
      return e0?.kind === 'segment' && e1?.kind === 'segment'
        ? { ...base, type: 'perpendicular_ll', l1_id: e0.id, l2_id: e1.id } : null
    case 'tangent': {
      if (!e0 || !e1) return null
      const kinds = `${e0.kind}/${e1.kind}`
      if (kinds === 'segment/circle') return { ...base, type: 'tangent_lc', l_id: e0.id, c_id: e1.id }
      if (kinds === 'circle/segment') return { ...base, type: 'tangent_lc', l_id: e1.id, c_id: e0.id }
      if (kinds === 'segment/arc') return { ...base, type: 'tangent_la', l_id: e0.id, a_id: e1.id }
      if (kinds === 'arc/segment') return { ...base, type: 'tangent_la', l_id: e1.id, a_id: e0.id }
      if (kinds === 'circle/circle') return { ...base, type: 'tangent_cc', c1_id: e0.id, c2_id: e1.id }
      if (kinds === 'arc/arc') return { ...base, type: 'tangent_aa', a1_id: e0.id, a2_id: e1.id }
      if (kinds === 'circle/arc') return { ...base, type: 'tangent_ca', c_id: e0.id, a_id: e1.id }
      if (kinds === 'arc/circle') return { ...base, type: 'tangent_ca', c_id: e1.id, a_id: e0.id }
      return null
    }
    case 'equal':
      return e0?.kind === 'segment' && e1?.kind === 'segment'
        ? { ...base, type: 'equal_length', l1_id: e0.id, l2_id: e1.id } : null
    case 'pointOn': {
      const a = p(0)
      if (!a || !e1) return null
      if (e1.kind === 'segment') return { ...base, type: 'point_on_line_pl', p_id: a, l_id: e1.id }
      if (e1.kind === 'circle') return { ...base, type: 'point_on_circle', p_id: a, c_id: e1.id }
      if (e1.kind === 'arc') return { ...base, type: 'point_on_arc', p_id: a, a_id: e1.id }
      return null
    }
    case 'distance': {
      const v = c.value ?? 0
      // Single segment ref = its length; two points = point distance;
      // point + curve(line) = orthogonal distance.
      if (c.refs.length === 1 && e0?.kind === 'segment') {
        return { ...base, type: 'p2p_distance', p1_id: `${e0.id}.a`, p2_id: `${e0.id}.b`, distance: v }
      }
      const a = p(0), b = p(1)
      if (a && b) return { ...base, type: 'p2p_distance', p1_id: a, p2_id: b, distance: v }
      if (a && e1?.kind === 'segment') return { ...base, type: 'p2l_distance', p_id: a, l_id: e1.id, distance: v }
      return null
    }
    case 'radius':
      if (e0?.kind === 'circle') return { ...base, type: 'circle_radius', c_id: e0.id, radius: c.value ?? 1 }
      if (e0?.kind === 'arc') return { ...base, type: 'arc_radius', a_id: e0.id, radius: c.value ?? 1 }
      return null
    case 'angle':
      return e0?.kind === 'segment' && e1?.kind === 'segment'
        ? { ...base, type: 'l2l_angle_ll', l1_id: e0.id, l2_id: e1.id, angle: ((c.value ?? 0) * Math.PI) / 180 }
        : null
  }
}

/** Solve a sketch (optionally with a dragged point pinned to the pointer) and
 *  return solved entity copies + solver diagnostics. Never mutates the input. */
export function solveSketch(sketch: SketchFeature, drag?: DragTarget): SolveOutcome {
  if (!wrapper) throw new Error('planegcs not initialized')
  const entities: SketchEntity[] = JSON.parse(JSON.stringify(sketch.entities))
  const byId = new Map(entities.map(e => [e.id, e]))

  // Apply the drag target before building primitives; the dragged point is
  // pinned (fixed) and the rest of the sketch follows the constraints.
  const pinned = new Set<string>(['__origin'])
  if (drag) {
    const e = byId.get(drag.entity)
    const target = { x: drag.x, y: drag.y }
    if (e) {
      if (e.kind === 'point') e.p = target
      else if (e.kind === 'segment') { if (drag.point === 'a') e.a = target; else e.b = target }
      else if (e.kind === 'circle') e.c = target
      else if (e.kind === 'arc' && drag.point === 'center') e.c = target
      const pid = pointId(e, drag.point)
      if (pid) pinned.add(pid)
    }
  }

  const points: Prim[] = [pt('__origin', { x: 0, y: 0 }, true)]
  const curves: Prim[] = []
  for (const e of entities) {
    switch (e.kind) {
      case 'point':
        points.push(pt(`${e.id}.p`, e.p, pinned.has(`${e.id}.p`)))
        break
      case 'segment':
        points.push(pt(`${e.id}.a`, e.a, pinned.has(`${e.id}.a`)))
        points.push(pt(`${e.id}.b`, e.b, pinned.has(`${e.id}.b`)))
        curves.push({ id: e.id, type: 'line', p1_id: `${e.id}.a`, p2_id: `${e.id}.b` })
        break
      case 'circle':
        points.push(pt(`${e.id}.c`, e.c, pinned.has(`${e.id}.c`)))
        curves.push({ id: e.id, type: 'circle', c_id: `${e.id}.c`, radius: e.r })
        break
      case 'arc': {
        const s = { x: e.c.x + Math.cos(e.a0) * e.r, y: e.c.y + Math.sin(e.a0) * e.r }
        const en = { x: e.c.x + Math.cos(e.a1) * e.r, y: e.c.y + Math.sin(e.a1) * e.r }
        points.push(pt(`${e.id}.c`, e.c, pinned.has(`${e.id}.c`)))
        points.push(pt(`${e.id}.s`, s, pinned.has(`${e.id}.s`)))
        points.push(pt(`${e.id}.e`, en, pinned.has(`${e.id}.e`)))
        curves.push({
          id: e.id, type: 'arc', c_id: `${e.id}.c`, radius: e.r,
          start_angle: e.a0, end_angle: e.a1, start_id: `${e.id}.s`, end_id: `${e.id}.e`,
        })
        curves.push({ id: `${e.id}.rules`, type: 'arc_rules', a_id: e.id })
        break
      }
      default: break // rect/poly primitives don't participate in solving
    }
  }
  const constraints = (sketch.constraints ?? [])
    .map(c => toGcs(c, byId))
    .filter((c): c is Prim => !!c)

  const w = wrapper
  w.clear_data()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  w.push_primitives_and_params([...points, ...curves, ...constraints] as any)
  const status = w.solve()
  const ok = status === 0 || status === 1 // Success | Converged
  const conflicting = w.get_gcs_conflicting_constraints().map(String)
  const redundant = w.get_gcs_redundant_constraints().map(String)
  const dof = w.gcs.dof()
  if (ok) {
    w.apply_solution()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const solved = new Map<string, any>()
    for (const prim of w.sketch_index.get_primitives()) solved.set(String(prim.id), prim)
    const solvedPt = (id: string, fallback: Vec2): Vec2 => {
      const sp = solved.get(id)
      return sp ? { x: sp.x, y: sp.y } : fallback
    }
    for (const e of entities) {
      if (e.kind === 'point') e.p = solvedPt(`${e.id}.p`, e.p)
      else if (e.kind === 'segment') {
        e.a = solvedPt(`${e.id}.a`, e.a)
        e.b = solvedPt(`${e.id}.b`, e.b)
      } else if (e.kind === 'circle') {
        e.c = solvedPt(`${e.id}.c`, e.c)
        const sp = solved.get(e.id)
        if (sp && typeof sp.radius === 'number') e.r = sp.radius
      } else if (e.kind === 'arc') {
        e.c = solvedPt(`${e.id}.c`, e.c)
        const sp = solved.get(e.id)
        if (sp) {
          if (typeof sp.radius === 'number') e.r = sp.radius
          if (typeof sp.start_angle === 'number') e.a0 = sp.start_angle
          if (typeof sp.end_angle === 'number') e.a1 = sp.end_angle
        }
      }
    }
  }
  return { ok, dof, conflicting, redundant, entities }
}
