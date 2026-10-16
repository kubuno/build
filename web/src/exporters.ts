import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

// Mesh exporters for the backstage: binary STL (universal 3D printing) and
// GLB (glTF binary, universal viewers). Input is the engine's exportSolids()
// group - meshes with world transforms already baked.

/** Serialize every mesh under `root` into one binary STL. */
export function toBinaryStl(root: THREE.Object3D): ArrayBuffer {
  root.updateMatrixWorld(true)
  const meshes: THREE.Mesh[] = []
  root.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh) })
  let triCount = 0
  for (const m of meshes) {
    const g = m.geometry
    triCount += (g.getIndex()?.count ?? g.getAttribute('position').count) / 3
  }
  const buffer = new ArrayBuffer(84 + 50 * triCount)
  const view = new DataView(buffer)
  view.setUint32(80, triCount, true)
  let off = 84
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3()
  for (const m of meshes) {
    const g = m.geometry
    const pos = g.getAttribute('position')
    const index = g.getIndex()
    const count = index ? index.count : pos.count
    const at = (i: number) => (index ? index.getX(i) : i)
    for (let i = 0; i < count; i += 3) {
      a.fromBufferAttribute(pos, at(i)).applyMatrix4(m.matrixWorld)
      b.fromBufferAttribute(pos, at(i + 1)).applyMatrix4(m.matrixWorld)
      c.fromBufferAttribute(pos, at(i + 2)).applyMatrix4(m.matrixWorld)
      n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize()
      for (const v of [n, a, b, c]) {
        view.setFloat32(off, v.x, true)
        view.setFloat32(off + 4, v.y, true)
        view.setFloat32(off + 8, v.z, true)
        off += 12
      }
      off += 2 // attribute byte count
    }
  }
  return buffer
}

/** Serialize `root` into a self-contained GLB (binary glTF). */
export function toGlb(root: THREE.Object3D): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      root,
      result => resolve(result as ArrayBuffer),
      err => reject(err),
      { binary: true },
    )
  })
}

/** Trigger a browser download of raw bytes. */
export function downloadBytes(data: ArrayBuffer, filename: string, mime = 'application/octet-stream') {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([data], { type: mime }))
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}
