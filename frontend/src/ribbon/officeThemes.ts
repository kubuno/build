// Teinte du ruban App (façon MS Office : une couleur de bande d'onglets qui sert
// aussi d'accent). Vendoré depuis Office (système de ruban partagé, pas d'import
// cross-module). Le corps + le contenu du ruban restent blancs.
import { WORKSPACE_OFFICE, type WorkspaceTheme } from '@kubuno/sdk'

// Construit un thème « ruban coloré » à partir d'une couleur de bande d'onglets.
export function officeTheme(color: string): WorkspaceTheme {
  return { ...WORKSPACE_OFFICE, topbarBg: color, topbarText: '#ffffff', accent: color }
}

// Éclaircit une couleur hex en la mélangeant vers le blanc (f = 0..1).
function lighten(hex: string, f: number): string {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  const mix = (c: number) => Math.round(c + (255 - c) * f)
  return `#${[mix(r), mix(g), mix(b)].map(c => c.toString(16).padStart(2, '0')).join('')}`
}

// Couleur de l'onglet « Fichier » + rail du backstage : une teinte PLUS CLAIRE de
// l'accent (ressort sur la bande d'onglets foncée, façon Office).
export function fileAccentFor(accent: string): string {
  return lighten(accent, 0.3)
}

// Build — une teinte par sous-application (façon Office : chaque éditeur a sa
// couleur de bande d'onglets). Architect = bleu ardoise (plans), CAO3D = acier
// orangé (mécanique, façon Fusion).
export const THEME_ARCHITECT = officeTheme('#1f6f8b')
export const THEME_CAO3D = officeTheme('#c2571a')
