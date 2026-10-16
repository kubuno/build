import type { ScreenPoint } from './Viewport3D'

// Immediate-mode HTML label layer for crisp dimension/tool labels drawn over the
// WebGL canvas. Engines call begin() once per frame, add() for each visible
// label, then end() to hide the leftovers. Elements are pooled - no per-frame
// allocation, no React churn.
export interface LabelStyle {
  color?: string
  background?: string
  bold?: boolean
  faded?: boolean
}

export class LabelLayer {
  private pool: HTMLDivElement[] = []
  private used = 0

  constructor(private root: HTMLDivElement) {}

  begin(): void { this.used = 0 }

  add(text: string, sp: ScreenPoint, style: LabelStyle = {}): void {
    if (!sp.visible) return
    let el = this.pool[this.used]
    if (!el) {
      el = document.createElement('div')
      el.style.position = 'absolute'
      el.style.left = '0'
      el.style.top = '0'
      el.style.whiteSpace = 'nowrap'
      el.style.fontSize = '11px'
      el.style.fontWeight = '600'
      el.style.padding = '1px 5px'
      el.style.borderRadius = '4px'
      el.style.pointerEvents = 'none'
      el.style.userSelect = 'none'
      el.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif'
      this.root.appendChild(el)
      this.pool.push(el)
    }
    el.textContent = text
    el.style.display = 'block'
    el.style.color = style.color ?? '#e8eef6'
    el.style.background = style.background ?? 'rgba(14,17,22,0.78)'
    el.style.fontWeight = style.bold ? '700' : '600'
    el.style.opacity = style.faded ? '0.75' : '1'
    el.style.transform = `translate(-50%, -50%) translate(${Math.round(sp.x)}px, ${Math.round(sp.y)}px)`
    this.used++
  }

  end(): void {
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].style.display = 'none'
  }

  dispose(): void {
    this.pool.forEach(el => el.remove())
    this.pool = []
    this.used = 0
  }
}
