import type * as THREE from 'three'
import type { Manifold } from 'manifold-3d'
import type { CaoModel, Feature, SketchEntity, SketchFeature, SketchPlane, SolidFeature } from './cao3dModel'
import { featureRefs, isSolidFeature, sketchLoops } from './cao3dModel'
import { loftSolid, padSolid, primitiveSolid, revolveSolid, transformSolid } from './cao3dGeometry'
import { isGroundIdentity, planeBasis, planeMatrix } from './sketchPlane'
import { geometryFromManifold, kernel, type FaceRun } from './kernel'

// The parametric recompute pipeline (FreeCAD's Document::recompute, in
// miniature): replay the feature timeline in order, each feature reading the
// results of the features it references. A failing feature gets an error flag
// - it never invalidates the document - and features after the rollback tip
// are simply not computed. All Manifold intermediates are freed before
// returning; only display geometry (three.js) leaves this module.

export interface FeatureRuntime {
  feature: Feature
  /** Human-readable problem (dangling/suppressed reference, kernel error). */
  error?: string
  /** False when suppressed or beyond the rollback tip. */
  computed: boolean
  /** Sketch referenced by a computed solid / solid swallowed by a combine:
   *  still fully editable, but hidden from the viewport. */
  consumed: boolean
  /** Display mesh for visible computed solids. */
  geometry?: THREE.BufferGeometry
  /** Face-provenance runs of `geometry` (originalID → see `provenance`). */
  runs?: FaceRun[]
}

export interface RecomputeResult {
  items: Map<string, FeatureRuntime>
  /** Manifold originalID → feature id (stable face naming across booleans). */
  provenance: Map<number, string>
}

const refsOf = featureRefs

/** First closed profile loop of a sketch - the profile solids are built from.
 *  Chained segment/arc loops come back as synthetic closed polys. */
function profileOf(sketch: SketchFeature): SketchEntity | null {
  return sketchLoops(sketch)[0] ?? null
}

export function recompute(model: CaoModel): RecomputeResult {
  const items = new Map<string, FeatureRuntime>()
  const provenance = new Map<number, string>()
  const tipIndex = model.tip ? model.features.findIndex(f => f.id === model.tip) : model.features.length - 1
  const inScope = (i: number) => tipIndex < 0 || i <= tipIndex

  // Runtime shells first, so consumption/lookup can address any feature.
  model.features.forEach((f, i) => {
    items.set(f.id, {
      feature: f,
      computed: inScope(i) && !f.suppressed,
      consumed: false,
    })
  })

  // Consumption: a computed feature hides what it references (the sketch under
  // a pad, the operands of a combine) - hidden but still editable.
  for (const f of model.features) {
    if (!items.get(f.id)!.computed) continue
    for (const ref of refsOf(f)) {
      const dep = items.get(ref)
      if (dep) dep.consumed = true
    }
  }

  // Solids built this pass (feature id → Manifold, before the feature's own
  // pos/rot, which is applied at display time on the Object3D). Leaves are
  // stamped `asOriginal` so their faces stay attributable through booleans.
  const solids = new Map<string, Manifold>()
  /** Cut tools of pocket/groove features, kept so mirror/pattern can repeat
   *  the CUT (the hole) instead of unioning solids - which would fill it. */
  const cutters = new Map<string, Manifold>()
  /** Posed operand clones for combines - freed at the end. */
  const scratch: Manifold[] = []

  const sketchAt = (id: string): SketchFeature | null => {
    const rt = items.get(id)
    return rt && rt.computed && rt.feature.type === 'sketch' ? rt.feature : null
  }
  const needProfile = (id: string): SketchEntity => {
    const sk = sketchAt(id)
    if (!sk) throw new Error('Esquisse introuvable, supprimée ou non calculée')
    const e = profileOf(sk)
    if (!e) throw new Error('L’esquisse n’a pas de contour fermé')
    return e
  }
  /** Combine operand: the target solid with its own pos/rot baked in. */
  const posedSolidAt = (id: string): Manifold => {
    const rt = items.get(id)
    const base = solids.get(id)
    if (!rt || !base || !rt.computed || !isSolidFeature(rt.feature)) {
      throw new Error('Opérande introuvable ou non calculé')
    }
    const posed = transformSolid(base, rt.feature.pos, rt.feature.rot)
    if (posed !== base) scratch.push(posed)
    return posed
  }

  const planeOf = (id: string): SketchPlane => sketchAt(id)?.plane ?? { kind: 'ground' }
  /** Solids are built flat (ground space) then laid onto the sketch plane. */
  const onPlane = (m: Manifold, plane: SketchPlane): Manifold => {
    if (isGroundIdentity(plane)) return m
    const mat = planeMatrix(planeBasis(plane))
    const out = m.transform(mat.elements as Parameters<Manifold['transform']>[0])
    m.delete()
    return out
  }

  const { Manifold } = kernel()

  /** target − cutter; the cutter is retained in `cutters` for reuse by
   *  mirror/pattern (freed at the end of the pass). */
  const subtract = (featureId: string, targetId: string, cutter: Manifold): Manifold => {
    const target = posedSolidAt(targetId)
    cutters.set(featureId, cutter)
    return Manifold.difference(target, cutter)
  }

  /** The cut tool of a pocket/groove, posed like the feature itself. */
  const posedCutterOf = (id: string): Manifold | null => {
    const rt = items.get(id)
    const base = cutters.get(id)
    if (!rt || !base) return null
    const f = rt.feature as SolidFeature
    const posed = transformSolid(base, f.pos, f.rot)
    if (posed !== base) scratch.push(posed)
    return posed
  }

  const buildSolid = (f: SolidFeature): Manifold => {
    switch (f.type) {
      case 'pad': return stampOriginal(onPlane(padSolid(needProfile(f.sketch), f.height, f.edgeMod), planeOf(f.sketch)), f.id)
      case 'revolve': return stampOriginal(onPlane(revolveSolid(needProfile(f.sketch), f.angleDeg), planeOf(f.sketch)), f.id)
      // A loft between two sketches lives in the FIRST sketch's plane.
      case 'loft': return stampOriginal(onPlane(loftSolid(needProfile(f.sketchA), needProfile(f.sketchB), f.height), planeOf(f.sketchA)), f.id)
      case 'primitive': return stampOriginal(primitiveSolid(f), f.id)
      case 'pocket': {
        // The cutter digs INTO the target: extrude spans [-height, +0.5] along
        // the sketch normal (the small overshoot avoids coplanar CSG slivers).
        const raw = padSolid(needProfile(f.sketch), f.height + 0.5)
        const shifted = raw.translate(0, -f.height, 0)
        raw.delete()
        return subtract(f.id, f.target, onPlane(shifted, planeOf(f.sketch)))
      }
      case 'groove':
        return subtract(f.id, f.target, onPlane(revolveSolid(needProfile(f.sketch), f.angleDeg), planeOf(f.sketch)))
      case 'mirror': {
        const t = posedSolidAt(f.target)
        const n: [number, number, number] = f.axis === 'x' ? [1, 0, 0] : [0, 0, 1]
        // Mirroring a cut feature mirrors the CUT (FreeCAD semantics): a plain
        // solid union would fill the mirrored-away hole with material.
        const cutter = posedCutterOf(f.target)
        if (cutter) {
          const mc = cutter.mirror(n)
          const out = Manifold.difference(t, mc)
          mc.delete()
          return out
        }
        const m = t.mirror(n)
        const out = Manifold.union(t, m)
        m.delete()
        return out
      }
      case 'pattern': {
        const t = posedSolidAt(f.target)
        const n = Math.max(2, Math.round(f.count))
        const cutter = posedCutterOf(f.target)
        const place = (src: Manifold, i: number): Manifold => {
          if (f.mode === 'linear') {
            const s = f.spacing ?? 100
            const d = f.axis === 'z' ? [0, 0, 1] : [1, 0, 0]
            return src.translate(d[0] * s * i, d[1] * s * i, d[2] * s * i)
          }
          // Polar spread around the world vertical through the origin.
          const total = Math.max(1, Math.min(360, f.angleDeg ?? 360))
          const step = total >= 360 ? total / n : total / (n - 1)
          return src.rotate(0, step * i, 0)
        }
        const copies: Manifold[] = []
        for (let i = 1; i < n; i++) copies.push(place(cutter ?? t, i))
        // Cut features repeat the hole; anything else repeats the solid.
        let out: Manifold
        if (cutter) {
          const allCuts = Manifold.union(copies)
          out = Manifold.difference(t, allCuts)
          allCuts.delete()
        } else {
          out = Manifold.union([t, ...copies])
        }
        copies.forEach(c => c.delete())
        return out
      }
      case 'combine': {
        if (f.targets.length < 2) throw new Error('Il faut au moins deux opérandes')
        const { Manifold } = kernel()
        // Do NOT re-stamp the result: a combine keeps its operands' originalIDs,
        // so every face still names the feature it came from.
        let acc = posedSolidAt(f.targets[0])
        let owned = false
        for (let i = 1; i < f.targets.length; i++) {
          const b = posedSolidAt(f.targets[i])
          const next =
            f.operation === 'subtract' ? Manifold.difference(acc, b)
            : f.operation === 'intersect' ? Manifold.intersection(acc, b)
            : Manifold.union(acc, b)
          if (owned) acc.delete()
          acc = next
          owned = true
        }
        return acc
      }
    }
  }

  /** Leaf solids get a fresh originalID mapped back to their feature. */
  const stampOriginal = (m: Manifold, featureId: string): Manifold => {
    const original = m.asOriginal()
    m.delete()
    provenance.set(original.originalID(), featureId)
    return original
  }

  try {
    for (const f of model.features) {
      const rt = items.get(f.id)!
      if (!rt.computed || !isSolidFeature(f)) continue
      try {
        solids.set(f.id, buildSolid(f))
      } catch (err) {
        rt.error = err instanceof Error ? err.message : 'Échec du calcul'
      }
    }

    // Display geometry for visible (non-consumed) solids.
    for (const [id, solid] of solids) {
      const rt = items.get(id)!
      if (rt.consumed) continue
      const { geometry, runs } = geometryFromManifold(solid)
      rt.geometry = geometry
      rt.runs = runs
    }
  } finally {
    for (const m of scratch) m.delete()
    for (const m of cutters.values()) m.delete()
    for (const m of solids.values()) m.delete()
  }

  return { items, provenance }
}
