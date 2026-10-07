import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { NavCube } from './navcube'
import type { Vec2 } from './geometry'

// Shared 3D/2D viewport for the Build editors. World is metric: 1 three.js unit
// = 1 mm. Plan (2D) drawing happens on the XZ ground plane (y = 0); the model's
// height grows along +Y. A Vec2 {x,y} maps to world (x, elevation, y).
//
// The viewport owns the render loop, camera, grid, lighting and an HTML overlay
// used for crisp dimension labels. Editors receive a `ViewportHandle` via
// `onReady` and drive everything imperatively (pointer picking, adding geometry,
// projecting labels), which keeps the heavy modeling code out of React renders.

export interface ScreenPoint {
  x: number
  y: number
  visible: boolean
}

export interface ViewportHandle {
  scene: THREE.Scene
  /** Group editors add their geometry to (kept apart from grid/axes helpers). */
  content: THREE.Group
  camera: THREE.Camera
  renderer: THREE.WebGLRenderer
  controls: OrbitControls
  domElement: HTMLCanvasElement
  /** Absolutely-positioned, pointer-transparent layer for dimension labels. */
  overlay: HTMLDivElement
  mode: '2d' | '3d'
  /** Raycast a client (mouse) position onto the horizontal plane at `planeY`. */
  planePoint: (clientX: number, clientY: number, planeY?: number) => Vec2 | null
  /** World-space ray through a client (mouse) position (for axis-drag tools). */
  screenRay: (clientX: number, clientY: number) => THREE.Ray
  /** Project a world position to overlay pixel coordinates. */
  project: (world: THREE.Vector3) => ScreenPoint
  /** Register a per-frame callback (label sync, previews). Returns an unregister. */
  registerFrame: (cb: () => void) => () => void
  /** Switch between top-down plan (2D) and perspective (3D) at runtime. */
  setViewMode: (mode: '2d' | '3d') => void
  /** Lock the ortho camera face-on to an arbitrary plane (sketch editing on a
   *  face or an origin plane). Reported mode is '2d'; leave via setViewMode. */
  setPlaneView: (origin: THREE.Vector3, normal: THREE.Vector3, up: THREE.Vector3, halfExtentMm?: number) => void
  /** Orthographic projection in the 3D view (CAD standard), preserving the
   *  current viewpoint. */
  setOrtho3d: (on: boolean) => void
  /** Frame the camera on the content bounding box (falls back to the grid). */
  fitView: () => void
}

export interface ViewportConfig {
  /** Half-extent of the grid in mm (grid spans 2×extent). */
  gridExtentMm?: number
  /** Grid cell size in mm. */
  gridCellMm?: number
}

export function Viewport3D({
  mode = '3d',
  accent = '#1f6f8b',
  gridExtentMm = 10000,
  gridCellMm = 1000,
  background = 0x0e1116,
  gridColor = 0x2a3038,
  gradient,
  gridIn3d = false,
  navCube = false,
  onReady,
  className,
}: {
  mode?: '2d' | '3d'
  accent?: string
  gridExtentMm?: number
  gridCellMm?: number
  /** Viewport clear colour. Architect stays dark; CAO3D uses a light grey. */
  background?: number
  /** Minor grid line colour (centre lines use the accent). */
  gridColor?: number
  /** Vertical background gradient [top, bottom] — Fusion-style studio backdrop. */
  gradient?: [number, number]
  /** Keep the sketch grid visible in 3D and swap the solid floor for a
   *  transparent shadow-catcher (CAD mode: one sketches in the 3D view). */
  gridIn3d?: boolean
  /** Corner navigation cube (standard views on click). */
  navCube?: boolean
  onReady?: (h: ViewportHandle) => void
  className?: string
} & ViewportConfig) {
  const mountRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const onReadyRef = useRef(onReady); onReadyRef.current = onReady
  const [webglError, setWebglError] = useState(false)

  useEffect(() => {
    const mount = mountRef.current
    const overlay = overlayRef.current
    if (!mount || !overlay) return
    let W = mount.clientWidth || 800, H = mount.clientHeight || 600

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true })
    } catch {
      setWebglError(true)
      return
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer.setSize(W, H)
    renderer.setClearColor(background, 1)
    renderer.localClippingEnabled = false
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    // Contact shadows anchor the model to the ground → kills the floating,
    // toy-model look. Soft PCF keeps edges clean under software rendering.
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    // Neutral studio environment → real reflections on glass/metal (no toy look).
    const pmrem = new THREE.PMREMGenerator(renderer)
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environment = envTex
    pmrem.dispose()

    // Optional vertical gradient backdrop (subtle studio falloff, à la Fusion).
    let bgTex: THREE.CanvasTexture | null = null
    if (gradient) {
      const cv = document.createElement('canvas')
      cv.width = 2; cv.height = 512
      const g2d = cv.getContext('2d')
      if (g2d) {
        const grad = g2d.createLinearGradient(0, 0, 0, 512)
        grad.addColorStop(0, `#${gradient[0].toString(16).padStart(6, '0')}`)
        grad.addColorStop(1, `#${gradient[1].toString(16).padStart(6, '0')}`)
        g2d.fillStyle = grad
        g2d.fillRect(0, 0, 2, 512)
        bgTex = new THREE.CanvasTexture(cv)
        bgTex.colorSpace = THREE.SRGBColorSpace
        scene.background = bgTex
      }
    }

    // --- Cameras (both kept; the active one is swapped by setViewMode). ---
    const persp = new THREE.PerspectiveCamera(50, W / H, 1, 500000)
    const orthoHalf = gridExtentMm * 0.65
    const ortho = new THREE.OrthographicCamera(-orthoHalf, orthoHalf, orthoHalf, -orthoHalf, -100000, 500000)

    let camera: THREE.Camera = mode === '2d' ? ortho : persp
    let controls = new OrbitControls(camera, renderer.domElement)
    controls.zoomToCursor = true // CAD-style: zoom toward the pointer

    const accentColor = new THREE.Color(accent)

    // --- Lighting ---
    scene.add(new THREE.AmbientLight(0xffffff, 0.55))
    const dir = new THREE.DirectionalLight(0xffffff, 1.0)
    dir.position.set(gridExtentMm * 0.4, gridExtentMm * 0.9, gridExtentMm * 0.5)
    // Sun casts shadows; the frustum is fitted to the model by fitView().
    dir.castShadow = true
    dir.shadow.mapSize.set(2048, 2048)
    dir.shadow.bias = -0.0006
    dir.shadow.normalBias = 40
    const sc = dir.shadow.camera as THREE.OrthographicCamera
    sc.near = 1; sc.far = gridExtentMm * 6
    const sh = gridExtentMm * 1.6
    sc.left = -sh; sc.right = sh; sc.top = sh; sc.bottom = -sh
    sc.updateProjectionMatrix()
    scene.add(dir)
    scene.add(dir.target)
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.28)
    dir2.position.set(-gridExtentMm * 0.5, gridExtentMm * 0.4, -gridExtentMm * 0.3)
    scene.add(dir2)

    // Ground plane, shown in 3D only. Architect: a matte floor that anchors the
    // buildings. CAD mode (gridIn3d): a transparent shadow-catcher so parts get
    // a contact shadow while the sketch grid stays visible through it.
    const groundMat: THREE.Material = gridIn3d
      ? new THREE.ShadowMaterial({ opacity: 0.26 })
      : new THREE.MeshStandardMaterial({ color: 0xd6dade, roughness: 0.96, metalness: 0.0 })
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(gridExtentMm * 8, gridExtentMm * 8), groundMat)
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -2
    ground.receiveShadow = true
    scene.add(ground)

    // --- Grid + axes (metric) ---
    const divisions = Math.max(2, Math.round((gridExtentMm * 2) / gridCellMm))
    const grid = new THREE.GridHelper(gridExtentMm * 2, divisions, accentColor, gridColor)
    const gm = grid.material as THREE.Material
    gm.transparent = true; gm.opacity = 0.45
    scene.add(grid)

    const axes = new THREE.AxesHelper(gridCellMm * 3)
    axes.visible = mode === '3d'
    scene.add(axes)

    const content = new THREE.Group()
    content.name = 'content'
    scene.add(content)

    // --- Camera / controls configuration per mode ---
    let ortho3d = false
    const applyMode = (m: '2d' | '3d', keepView = false) => {
      const prevPos = camera.position.clone()
      const prevTarget = controls.target.clone()
      const target = keepView ? prevTarget : new THREE.Vector3(0, 0, 0)
      controls.dispose()
      if (m === '2d') {
        camera = ortho
        ortho.position.set(0, 100000, 0)
        ortho.up.set(0, 0, -1)
        ortho.lookAt(target)
        controls = new OrbitControls(ortho, renderer.domElement)
        controls.zoomToCursor = true // CAD-style: zoom toward the pointer
        controls.enableRotate = false
        controls.screenSpacePanning = true
        controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
        axes.visible = false
        ground.visible = false
        grid.visible = true
      } else {
        // 3D view: perspective by default, orthographic on demand (CAD look).
        const pos = keepView
          ? prevPos
          : new THREE.Vector3(gridExtentMm * 0.5, gridExtentMm * 0.55, gridExtentMm * 0.85)
        if (ortho3d) {
          camera = ortho
          ortho.up.set(0, 1, 0)
          ortho.position.copy(pos)
          ortho.zoom = 1
          const half = Math.max(1, pos.distanceTo(target) * Math.tan((persp.fov / 2) * Math.PI / 180))
          const aspect = W / H
          ortho.left = -half * aspect; ortho.right = half * aspect
          ortho.top = half; ortho.bottom = -half
          ortho.updateProjectionMatrix()
          ortho.lookAt(target)
        } else {
          camera = persp
          persp.position.copy(pos)
          persp.up.set(0, 1, 0)
          persp.lookAt(target)
        }
        controls = new OrbitControls(camera, renderer.domElement)
        controls.zoomToCursor = true // CAD-style: zoom toward the pointer
        controls.enableRotate = true
        controls.maxPolarAngle = Math.PI * 0.495 // don't go under the ground
        controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
        axes.visible = true
        ground.visible = true
        grid.visible = gridIn3d // CAD mode sketches in 3D → keep the grid
      }
      controls.target.copy(target)
      controls.enableDamping = true
      controls.dampingFactor = 0.1
      controls.update()
      handle.camera = camera
      handle.controls = controls
      handle.mode = m
    }

    // Face-on ortho view of an arbitrary plane (sketching on faces/origin
    // planes). Grid/ground/axes hide: they belong to the ground plane only.
    const setPlaneView = (origin: THREE.Vector3, normal: THREE.Vector3, up: THREE.Vector3, halfExtentMm = 350) => {
      controls.dispose()
      camera = ortho
      ortho.position.copy(origin).addScaledVector(normal, 100000)
      ortho.up.copy(up)
      ortho.lookAt(origin)
      const aspect = W / H
      ortho.left = -halfExtentMm * aspect; ortho.right = halfExtentMm * aspect
      ortho.top = halfExtentMm; ortho.bottom = -halfExtentMm
      ortho.updateProjectionMatrix()
      controls = new OrbitControls(ortho, renderer.domElement)
      controls.zoomToCursor = true // CAD-style: zoom toward the pointer
      controls.enableRotate = false
      controls.screenSpacePanning = true
      controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
      controls.target.copy(origin)
      controls.enableDamping = true
      controls.dampingFactor = 0.1
      controls.update()
      axes.visible = false
      ground.visible = false
      grid.visible = false
      handle.camera = camera
      handle.controls = controls
      handle.mode = '2d'
    }

    // --- Picking / projection helpers ---
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const planeVec = new THREE.Vector3()

    const planePoint = (clientX: number, clientY: number, planeY = 0): Vec2 | null => {
      const rect = renderer.domElement.getBoundingClientRect()
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY)
      const hit = raycaster.ray.intersectPlane(plane, planeVec)
      return hit ? { x: hit.x, y: hit.z } : null
    }

    const screenRay = (clientX: number, clientY: number): THREE.Ray => {
      const rect = renderer.domElement.getBoundingClientRect()
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)
      return raycaster.ray.clone()
    }

    const project = (world: THREE.Vector3): ScreenPoint => {
      const v = world.clone().project(camera)
      return { x: (v.x * 0.5 + 0.5) * W, y: (1 - (v.y * 0.5 + 0.5)) * H, visible: v.z < 1 && v.z > -1 }
    }

    // --- Per-frame callbacks (labels, previews) ---
    const frameCbs = new Set<() => void>()
    const registerFrame = (cb: () => void) => { frameCbs.add(cb); return () => { frameCbs.delete(cb) } }

    const fitView = () => {
      const box = new THREE.Box3().setFromObject(content)
      if (box.isEmpty()) return
      const center = new THREE.Vector3(); box.getCenter(center)
      const size = new THREE.Vector3(); box.getSize(size)
      // Keep the sun (and its shadow frustum) centred on the model so contact
      // shadows stay crisp whatever the scene size.
      const span = Math.max(size.x, size.z, gridCellMm)
      dir.position.set(center.x + span * 0.5, center.y + Math.max(size.y, span) * 1.1 + span * 0.4, center.z + span * 0.35)
      dir.target.position.copy(center)
      dir.target.updateMatrixWorld()
      const shalf = Math.max(size.x, size.z, size.y) * 0.85
      sc.left = -shalf; sc.right = shalf; sc.top = shalf; sc.bottom = -shalf
      sc.far = shalf * 12; sc.updateProjectionMatrix()
      if (handle.mode === '2d') {
        controls.target.copy(center)
        ortho.position.set(center.x, 100000, center.z)
        const half = Math.max(size.x, size.z, gridCellMm) * 0.7
        ortho.left = -half * (W / H); ortho.right = half * (W / H)
        ortho.top = half; ortho.bottom = -half
        ortho.updateProjectionMatrix()
      } else {
        // Skyline framing: tight horizontal fit, a low dramatic angle rather
        // than a distant top-down that shrinks everything to toy scale.
        const radius = Math.max(size.x, size.z, size.y * 0.8, gridCellMm) * 0.6
        const d = radius * 1.9
        controls.target.set(center.x, center.y * 0.75 + size.y * 0.12, center.z)
        const pos = new THREE.Vector3(center.x + d * 0.85, center.y + d * 0.55 + size.y * 0.1, center.z + d * 0.85)
        if (camera === ortho) {
          // 3D orthographic: refit the frustum to the content radius.
          ortho.position.copy(pos)
          ortho.zoom = 1
          const half = radius * 1.25
          const aspect = W / H
          ortho.left = -half * aspect; ortho.right = half * aspect
          ortho.top = half; ortho.bottom = -half
          ortho.updateProjectionMatrix()
        } else {
          persp.position.copy(pos)
        }
      }
      controls.update()
    }

    const handle: ViewportHandle = {
      scene, content, camera, renderer, controls,
      domElement: renderer.domElement, overlay,
      mode,
      planePoint, screenRay, project, registerFrame,
      setViewMode: applyMode,
      setPlaneView,
      setOrtho3d: (on: boolean) => {
        if (ortho3d === on) return
        ortho3d = on
        if (handle.mode === '3d') applyMode('3d', true)
      },
      fitView,
    }

    applyMode(mode)
    // Corner navigation cube (3D views only) — synced + clickable.
    const navcube = navCube
      ? new NavCube(renderer, () => ({ camera: handle.camera, controls: handle.controls }))
      : null
    onReadyRef.current?.(handle)

    // Newly-added content meshes must cast/receive shadows. Re-tag only when the
    // content group's child count changes (i.e. after a rebuild) — cheap.
    let taggedCount = -1
    const tagShadows = () => {
      if (content.children.length === taggedCount) return
      taggedCount = content.children.length
      content.traverse(o => {
        const m = o as THREE.Mesh
        if ((m as THREE.Mesh).isMesh) { m.castShadow = true; m.receiveShadow = true }
      })
    }

    let raf = 0
    const animate = () => {
      handle.controls.update()
      tagShadows()
      frameCbs.forEach(cb => cb())
      renderer.render(scene, handle.camera)
      if (navcube && handle.mode === '3d') navcube.render()
      raf = requestAnimationFrame(animate)
    }
    animate()

    const ro = new ResizeObserver(() => {
      W = mount.clientWidth || W; H = mount.clientHeight || H
      persp.aspect = W / H; persp.updateProjectionMatrix()
      const aspect = W / H
      const oh = (ortho.top - ortho.bottom) / 2
      ortho.left = -oh * aspect; ortho.right = oh * aspect
      ortho.updateProjectionMatrix()
      renderer.setSize(W, H)
    })
    ro.observe(mount)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      frameCbs.clear()
      navcube?.dispose()
      handle.controls.dispose()
      envTex.dispose()
      bgTex?.dispose()
      ground.geometry.dispose()
      groundMat.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
    }
    // Grid/mode are structural: a change rebuilds the whole scene.
  }, [accent, gridExtentMm, gridCellMm, background, gridColor, gridIn3d, navCube, gradient?.[0], gradient?.[1]]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={className} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
      <div ref={overlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }} />
      {webglError && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9fb0d8', fontSize: 13, textAlign: 'center', padding: 24 }}>
          Rendu 3D indisponible : votre navigateur n'expose pas WebGL.
        </div>
      )}
    </div>
  )
}
