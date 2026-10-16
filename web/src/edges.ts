import * as THREE from 'three'

// Dark outline edges à la Fusion 360: only edges whose adjacent faces differ by
// more than `thresholdDeg` are drawn, so a tessellated cylinder shows its rim
// circles and silhouette seam - not every facet. Wrap a mesh with its edges in a
// group so both share the mesh's transform and pick as the same element.
export function withEdges(mesh: THREE.Mesh, edgeMaterial: THREE.LineBasicMaterial, eid: string, thresholdDeg = 20): THREE.Group {
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, thresholdDeg), edgeMaterial)
  edges.userData.eid = eid
  const group = new THREE.Group()
  group.add(mesh)
  group.add(edges)
  group.userData.eid = eid
  return group
}
