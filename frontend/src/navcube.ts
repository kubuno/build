import * as THREE from 'three'

// Corner navigation cube (Fusion/FreeCAD style): a small labelled cube rendered
// in the top-right corner of the viewport with its own scene/camera, rotating
// in sync with the main camera. Clicking a face snaps the main camera to the
// matching standard view with a short eased animation. Pointer events inside
// the cube's corner are captured before the modeling engine sees them.

const SIZE = 96      // css px of the corner viewport
const MARGIN = 10

const FACE_DEFS: { label: string; dir: THREE.Vector3 }[] = [
  { label: 'DROITE', dir: new THREE.Vector3(1, 0, 0) },
  { label: 'GAUCHE', dir: new THREE.Vector3(-1, 0, 0) },
  { label: 'DESSUS', dir: new THREE.Vector3(0, 1, 0) },
  { label: 'DESSOUS', dir: new THREE.Vector3(0, -1, 0) },
  { label: 'FACE', dir: new THREE.Vector3(0, 0, 1) },
  { label: 'ARRIÈRE', dir: new THREE.Vector3(0, 0, -1) },
]

function faceTexture(label: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = 128
  const g = cv.getContext('2d')!
  g.fillStyle = '#f2f4f7'
  g.fillRect(0, 0, 128, 128)
  g.strokeStyle = '#b9c0c9'
  g.lineWidth = 6
  g.strokeRect(3, 3, 122, 122)
  g.fillStyle = '#4a515b'
  g.font = '600 21px ui-sans-serif, system-ui'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(label, 64, 66)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export class NavCube {
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 10)
  private cube: THREE.Mesh
  private raycaster = new THREE.Raycaster()
  private hovered = -1
  private mats: THREE.MeshBasicMaterial[]
  /** Animation state: camera flies to a standard view over a few frames. */
  private anim: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null

  constructor(
    private renderer: THREE.WebGLRenderer,
    /** Live accessors — the main camera/controls are swapped by view changes. */
    private main: () => { camera: THREE.Camera; controls: { target: THREE.Vector3; update: () => void } },
  ) {
    this.mats = FACE_DEFS.map(f => new THREE.MeshBasicMaterial({ map: faceTexture(f.label) }))
    // BoxGeometry material order: +x, -x, +y, -y, +z, -z — matches FACE_DEFS.
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.mats)
    this.scene.add(this.cube)
    this.camera.position.set(0, 0, 5)
    this.camera.lookAt(0, 0, 0)

    const el = renderer.domElement
    el.addEventListener('pointerdown', this.onDown, true)
    el.addEventListener('pointermove', this.onMove, true)
    el.addEventListener('pointerup', this.onUp, true)
  }

  private rect() {
    const r = this.renderer.domElement.getBoundingClientRect()
    return { left: r.right - SIZE - MARGIN, top: r.top + MARGIN, size: SIZE }
  }

  private inCube(ev: PointerEvent): { x: number; y: number } | null {
    const r = this.rect()
    const x = ev.clientX - r.left
    const y = ev.clientY - r.top
    return x >= 0 && x <= r.size && y >= 0 && y <= r.size ? { x, y } : null
  }

  private pickFace(p: { x: number; y: number }): number {
    const ndc = new THREE.Vector2((p.x / SIZE) * 2 - 1, -(p.y / SIZE) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    const hit = this.raycaster.intersectObject(this.cube, false)[0]
    return hit?.face ? hit.face.materialIndex : -1
  }

  private onMove = (ev: PointerEvent) => {
    const p = this.inCube(ev)
    const idx = p ? this.pickFace(p) : -1
    if (idx !== this.hovered) {
      this.mats.forEach((m, i) => m.color.setHex(i === idx ? 0xdbe6f5 : 0xffffff))
      this.hovered = idx
    }
    this.renderer.domElement.style.cursor = idx >= 0 ? 'pointer' : ''
    if (p) ev.stopImmediatePropagation()
  }

  private pressed = false
  private onDown = (ev: PointerEvent) => {
    if (this.inCube(ev)) { this.pressed = true; ev.stopImmediatePropagation() }
  }

  private onUp = (ev: PointerEvent) => {
    const p = this.inCube(ev)
    if (!this.pressed || !p) { this.pressed = false; return }
    this.pressed = false
    ev.stopImmediatePropagation()
    const idx = this.pickFace(p)
    if (idx >= 0) this.snapTo(FACE_DEFS[idx].dir)
  }

  /** Fly the main camera to look along -dir at the current target. */
  private snapTo(dir: THREE.Vector3) {
    const { camera, controls } = this.main()
    const dist = camera.position.distanceTo(controls.target)
    // Nudge pure top/bottom views so OrbitControls keeps a stable up vector.
    const d = dir.clone()
    if (Math.abs(d.y) > 0.99) d.add(new THREE.Vector3(0, 0, 0.02)).normalize()
    const to = controls.target.clone().addScaledVector(d, dist)
    this.anim = { from: camera.position.clone(), to, t: 0 }
  }

  /** Call once per frame after the main render: animates + draws the cube. */
  render() {
    const { camera, controls } = this.main()
    if (this.anim) {
      this.anim.t = Math.min(1, this.anim.t + 1 / 18)
      const k = 1 - Math.pow(1 - this.anim.t, 3) // ease-out
      camera.position.lerpVectors(this.anim.from, this.anim.to, k)
      camera.lookAt(controls.target)
      controls.update()
      if (this.anim.t >= 1) this.anim = null
    }
    // The cube shows the world orientation as seen from the camera.
    this.cube.quaternion.copy(camera.quaternion).invert()

    // setViewport/setScissor take CSS pixels (three multiplies by pixelRatio).
    const size = new THREE.Vector2()
    this.renderer.getSize(size)
    const x = size.x - SIZE - MARGIN
    const y = size.y - SIZE - MARGIN // from the bottom → top-right corner
    this.renderer.clearDepth()
    this.renderer.setScissorTest(true)
    this.renderer.setScissor(x, y, SIZE, SIZE)
    this.renderer.setViewport(x, y, SIZE, SIZE)
    this.renderer.render(this.scene, this.camera)
    this.renderer.setScissorTest(false)
    this.renderer.setViewport(0, 0, size.x, size.y)
  }

  dispose() {
    const el = this.renderer.domElement
    el.removeEventListener('pointerdown', this.onDown, true)
    el.removeEventListener('pointermove', this.onMove, true)
    el.removeEventListener('pointerup', this.onUp, true)
    this.cube.geometry.dispose()
    this.mats.forEach(m => { m.map?.dispose(); m.dispose() })
  }
}
