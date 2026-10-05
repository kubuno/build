// Shared 2D geometry + metric helpers for both Build sub-apps. The world is
// metric with 1 three.js unit = 1 millimetre, so all lengths here are in mm.
import type { Unit } from './types'

export interface Vec2 {
  x: number
  y: number
}

export const v2 = (x: number, y: number): Vec2 => ({ x, y })

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s })
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y
export const len = (a: Vec2): number => Math.hypot(a.x, a.y)
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)

export function normalize(a: Vec2): Vec2 {
  const l = len(a)
  return l < 1e-9 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }
}

/** Left-hand perpendicular (for wall thickness offsets). */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x })

export const angle = (a: Vec2): number => Math.atan2(a.y, a.x)

/** Closest point to `p` on segment [a,b] and the parametric t in [0,1]. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number; dist: number } {
  const ab = sub(b, a)
  const l2 = dot(ab, ab)
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2))
  const point = add(a, scale(ab, t))
  return { point, t, dist: dist(p, point) }
}

/** Signed area of a polygon (>0 = counter-clockwise). */
export function signedArea(pts: Vec2[]): number {
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}

export const polygonArea = (pts: Vec2[]): number => Math.abs(signedArea(pts))

/** Snap a value to the nearest step (e.g. 10 mm grid). */
export const snap = (value: number, step: number): number =>
  step > 0 ? Math.round(value / step) * step : value

export const snapVec = (p: Vec2, step: number): Vec2 => ({ x: snap(p.x, step), y: snap(p.y, step) })

/** Constrain b relative to a to horizontal / vertical / 45° when close. */
export function constrainOrtho(a: Vec2, b: Vec2, toleranceDeg = 6): Vec2 {
  const d = sub(b, a)
  const l = len(d)
  if (l < 1e-6) return b
  let ang = (Math.atan2(d.y, d.x) * 180) / Math.PI
  const step = 45
  const snapped = Math.round(ang / step) * step
  if (Math.abs(ang - snapped) <= toleranceDeg) {
    ang = (snapped * Math.PI) / 180
    return { x: a.x + Math.cos(ang) * l, y: a.y + Math.sin(ang) * l }
  }
  return b
}

const UNIT_TO_MM: Record<Unit, number> = { mm: 1, cm: 10, m: 1000 }

/** Format a millimetre length in the document's unit (e.g. 1250 mm → "1.25 m"). */
export function formatLength(mm: number, unit: Unit): string {
  const value = mm / UNIT_TO_MM[unit]
  const rounded = Math.abs(value) < 100 ? Math.round(value * 100) / 100 : Math.round(value * 10) / 10
  return `${rounded} ${unit}`
}

/** Format an area given in mm² into the unit's squared measure. */
export function formatArea(mm2: number, unit: Unit): string {
  const factor = UNIT_TO_MM[unit] * UNIT_TO_MM[unit]
  const value = mm2 / factor
  const rounded = Math.round(value * 100) / 100
  return `${rounded} ${unit}²`
}

/** Convert millimetres to the document unit (number, no formatting). */
export const mmToUnit = (mm: number, unit: Unit): number => mm / UNIT_TO_MM[unit]
/** Convert a value expressed in the document unit back to millimetres. */
export const unitToMm = (v: number, unit: Unit): number => v * UNIT_TO_MM[unit]
/** Sensible numeric step for editing a length in the given unit. */
export const unitStep = (unit: Unit): number => (unit === 'mm' ? 10 : unit === 'cm' ? 1 : 0.05)

/** Parse a user-typed length (in the document unit) back to millimetres. */
export function parseLength(text: string, unit: Unit): number | null {
  const m = text.trim().replace(',', '.').match(/^-?\d*\.?\d+/)
  if (!m) return null
  const value = parseFloat(m[0])
  if (!Number.isFinite(value)) return null
  return value * UNIT_TO_MM[unit]
}
