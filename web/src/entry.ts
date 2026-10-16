/** Build module bundle - loaded at runtime by the host (cf. vite.config). */
import { lazy } from 'react'
import {
  RouteRegistry, CollapseSidebarRegistry, WaffleAppRegistry, FileTypeRegistry,
  useToolbarStore, SDK_VERSION,
} from '@kubuno/sdk'
import { DraftingCompass, Building2, Box } from 'lucide-react'
import './index.css'
import './i18n'

export const sdkVersion = SDK_VERSION

export function register() {
  // Editors span the full width: collapse the core sidebar under /build.
  CollapseSidebarRegistry.add('/build')

  useToolbarStore.getState().register({ moduleId: 'build', routePrefix: '/build', noPadding: true })

  // One waffle entry per sub-app (Office-style: the module first, then each app).
  WaffleAppRegistry.register('build', 'Build', [
    { id: 'build', label: 'Build', Icon: DraftingCompass, path: '/build' },
    { id: 'build-architect', label: 'Architect', Icon: Building2, path: '/build/architect' },
    { id: 'build-cao3d', label: 'CAO3D', Icon: Box, path: '/build/cao3d' },
  ])

  // Document files live in drive (Build/Architect/*.kbarch, Build/CAO3D/*.kbcao):
  // register their types so a double-click in Files opens the right editor.
  FileTypeRegistry.register({
    moduleId: 'build-architect', label: 'Architect', icon: 'Building2',
    mimeTypes: ['application/vnd.kubuno.architect+json'],
    extensions: ['kbarch'],
    open: (f, nav) => { import('./api').then(({ buildApi }) => buildApi.openByFile(f.id).then(doc => nav(`/build/architect/${doc.id}`)).catch(() => {})) },
  })
  FileTypeRegistry.register({
    moduleId: 'build-cao3d', label: 'CAO3D', icon: 'Box',
    mimeTypes: ['application/vnd.kubuno.cao3d+json'],
    extensions: ['kbcao'],
    open: (f, nav) => { import('./api').then(({ buildApi }) => buildApi.openByFile(f.id).then(doc => nav(`/build/cao3d/${doc.id}`)).catch(() => {})) },
  })

  const BuildHub      = lazy(() => import('./BuildHub'))
  const ArchitectPage = lazy(() => import('./ArchitectPage'))
  const Cao3dPage     = lazy(() => import('./Cao3dPage'))

  RouteRegistry.register('build', BuildHub)
  // Sub-app landing (no document): editor chrome with the locked « Fichier »
  // backstage (start page), like the Office sub-apps.
  RouteRegistry.register('build/architect', ArchitectPage)
  RouteRegistry.register('build/architect/:id', ArchitectPage)
  RouteRegistry.register('build/cao3d', Cao3dPage)
  RouteRegistry.register('build/cao3d/:id', Cao3dPage)
}
