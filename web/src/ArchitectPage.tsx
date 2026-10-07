import { useCallback, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RectangleHorizontal, DoorOpen, AppWindow, Square, Route, Triangle, Tent,
  RectangleHorizontal as FlatRoof, Building2, Building, Cable, Blocks,
} from 'lucide-react'
import { BuildEditor } from './BuildEditor'
import { THEME_ARCHITECT } from './ribbon/officeThemes'
import type { RibbonGroup, RibbonTab } from './ribbon/types'
import type { EditorController, EngineContext } from './engine'
import { ArchitectEngine } from './ArchitectEngine'

function NumField({ label, value, onChange, suffix, w = 'w-14' }: { label: string; value: number; onChange: (v: number) => void; suffix?: string; w?: string }) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-text-secondary px-1">
      <span>{label}</span>
      <input
        type="number" value={value} min={1}
        onChange={e => onChange(Math.max(0, Number(e.target.value) || 0))}
        className={`${w} h-7 px-1.5 rounded-md border border-border bg-surface-1 text-text-primary text-[11px] text-right`}
      />
      {suffix && <span className="text-text-tertiary">{suffix}</span>}
    </label>
  )
}

// Architect: buildings / houses / roads / procedural cities. 2D plan with a 3D
// elevation toggle. Office-style ribbon: the everyday drawing tools (structure,
// openings, roofs) live in Accueil; Insertion holds the site tools and the
// procedural generators.
export default function ArchitectPage() {
  const { t } = useTranslation('build')
  const [floors, setFloors] = useState(6)
  const [seed, setSeed] = useState(1)

  const createEngine = useCallback((ctx: EngineContext) => new ArchitectEngine(ctx), [])

  const toolItem = (c: EditorController) => (id: string, label: string, icon: ReactNode, size?: 'large' | 'small') => ({
    id, kind: 'toggle' as const, size, label, icon, active: c.tool === id, onClick: () => c.setTool(id),
  })

  // Accueil — structure / openings / roofs (the everyday drawing tools).
  const homeGroups = useCallback((c: EditorController): RibbonGroup[] => {
    const tool = toolItem(c)
    return [
      {
        id: 'structure', label: t('arch_grp_structure', { defaultValue: 'Structure' }),
        items: [
          tool('wall', t('arch_wall', { defaultValue: 'Mur' }), <RectangleHorizontal size={18} />, 'large'),
          tool('room', t('arch_room', { defaultValue: 'Pièce' }), <Square size={18} />, 'large'),
        ],
      },
      {
        id: 'openings', label: t('arch_grp_openings', { defaultValue: 'Ouvertures' }),
        items: [
          tool('door', t('arch_door', { defaultValue: 'Porte' }), <DoorOpen size={18} />),
          tool('window', t('arch_window', { defaultValue: 'Fenêtre' }), <AppWindow size={18} />),
        ],
      },
      {
        id: 'roof', label: t('arch_grp_roof', { defaultValue: 'Toiture' }),
        items: [
          { id: 'roof-gable', kind: 'button', size: 'large', label: t('arch_roof_gable', { defaultValue: 'Bâtière' }), icon: <Triangle size={18} />, onClick: () => c.run('roof', { type: 'gable' }) },
          { id: 'roof-hip', kind: 'button', size: 'large', label: t('arch_roof_hip', { defaultValue: '4 pans' }), icon: <Tent size={18} />, onClick: () => c.run('roof', { type: 'hip' }) },
          { id: 'roof-flat', kind: 'button', label: t('arch_roof_flat', { defaultValue: 'Plat' }), icon: <FlatRoof size={18} />, onClick: () => c.run('roof', { type: 'flat' }) },
        ],
      },
    ]
  }, [t])

  // Insertion — site tools + procedural generators.
  const extraTabs = useCallback((c: EditorController): RibbonTab[] => {
    const tool = toolItem(c)
    return [{
      id: 'insert', label: t('tab_insert', { defaultValue: 'Insertion' }),
      groups: [
        {
          id: 'site', label: t('arch_grp_site', { defaultValue: 'Terrain' }),
          items: [
            tool('road', t('arch_road', { defaultValue: 'Route' }), <Route size={18} />, 'large'),
          ],
        },
        {
          id: 'generate', label: t('arch_grp_generate', { defaultValue: 'Générer' }),
          items: [
            { id: 'floors', kind: 'custom', render: <NumField label={t('arch_floors', { defaultValue: 'Étages' })} value={floors} onChange={setFloors} /> },
            { id: 'seed', kind: 'custom', render: <NumField label={t('arch_seed', { defaultValue: 'Graine' })} value={seed} onChange={setSeed} /> },
            { id: 'building', kind: 'button', size: 'large', label: t('arch_building', { defaultValue: 'Immeuble' }), icon: <Building2 size={18} />, onClick: () => c.run('building', { floors, seed }) },
            { id: 'skyscraper', kind: 'button', size: 'large', label: t('arch_skyscraper', { defaultValue: 'Gratte-ciel' }), icon: <Building size={18} />, onClick: () => c.run('skyscraper', { floors, seed }) },
            { id: 'bridge', kind: 'button', size: 'large', label: t('arch_bridge', { defaultValue: 'Pont' }), icon: <Cable size={18} />, onClick: () => c.run('bridge', { seed }) },
            { id: 'city', kind: 'button', size: 'large', label: t('arch_city', { defaultValue: 'Ville' }), icon: <Blocks size={18} />, onClick: () => c.run('city', { seed }) },
          ],
        },
      ],
    }]
  }, [t, floors, seed])

  return (
    <BuildEditor
      kind="architect"
      theme={THEME_ARCHITECT}
      accent="#1f6f8b"
      icon={<Building2 />}
      appLabel={t('architect', { defaultValue: 'Architect' })}
      newLabel={t('new_architect', { defaultValue: 'Nouveau bâtiment' })}
      viewportMode="2d"
      gridExtentMm={20000}
      gridCellMm={1000}
      gridStepMm={100}
      background={0xe9ecf0}
      gridColor={0xc4cad3}
      showViewToggle
      createEngine={createEngine}
      homeGroups={homeGroups}
      extraTabs={extraTabs}
    />
  )
}
