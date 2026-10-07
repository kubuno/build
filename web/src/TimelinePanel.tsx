import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { MenuDropdown, useMenuDropdown, type MenuItem } from '@ui'
import {
  PenLine, Box, RotateCcw, Layers, SquaresUnite,
  AlertTriangle, EyeOff, Pencil, Trash2, CircleSlash, History, Play, Shapes,
  SquareMinus, Disc, FlipHorizontal, Grid3x3,
} from 'lucide-react'
import type { TimelineItem } from './engine'

// Construction-history panel (FreeCAD model tree / Fusion timeline): the
// ordered list of parametric features. Click selects (highlighting the
// geometry and opening its parameters in the properties panel), double-click
// renames inline, right-click offers edit/suppress/delete/rollback. Features
// beyond the rollback tip are greyed out and skipped by recompute.

const TYPE_ICONS: Record<string, ReactNode> = {
  sketch: <PenLine size={13} />,
  pad: <Box size={13} />,
  revolve: <RotateCcw size={13} />,
  loft: <Layers size={13} />,
  combine: <SquaresUnite size={13} />,
  pocket: <SquareMinus size={13} />,
  groove: <Disc size={13} />,
  primitive: <Shapes size={13} />,
  mirror: <FlipHorizontal size={13} />,
  pattern: <Grid3x3 size={13} />,
}

export type TimelineAction =
  | { action: 'select'; id: string; additive: boolean }
  | { action: 'edit'; id: string }
  | { action: 'rename'; id: string; name: string }
  | { action: 'suppress'; id: string }
  | { action: 'delete'; id: string }
  | { action: 'tip'; id: string | null }

export function TimelinePanel({ items, onAction }: {
  items: TimelineItem[]
  onAction: (a: TimelineAction) => void
}) {
  const { t } = useTranslation('build')
  const menu = useMenuDropdown()
  const [menuFor, setMenuFor] = useState<TimelineItem | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const commitRename = (id: string) => {
    setRenaming(null)
    const v = draft.trim()
    if (v) onAction({ action: 'rename', id, name: v })
  }

  const tipActive = items.some(i => i.isTip)

  const menuItems = (it: TimelineItem): MenuItem[] => [
    ...(it.type === 'sketch' ? [{
      type: 'action' as const, label: t('sk_edit', { defaultValue: 'Modifier l’esquisse' }), icon: <PenLine size={14} />,
      onClick: () => onAction({ action: 'edit', id: it.id }),
    }] : []),
    {
      type: 'action', label: t('tl_rename', { defaultValue: 'Renommer' }), icon: <Pencil size={14} />,
      onClick: () => { setRenaming(it.id); setDraft(it.name) },
    },
    {
      type: 'action',
      label: it.suppressed
        ? t('tl_unsuppress', { defaultValue: 'Réactiver' })
        : t('tl_suppress', { defaultValue: 'Suspendre' }),
      icon: <CircleSlash size={14} />,
      onClick: () => onAction({ action: 'suppress', id: it.id }),
    },
    { type: 'separator' },
    {
      type: 'action', label: t('tl_rollback', { defaultValue: 'Reculer jusqu’ici' }), icon: <History size={14} />,
      disabled: it.isTip,
      onClick: () => onAction({ action: 'tip', id: it.id }),
    },
    ...(tipActive ? [{
      type: 'action' as const, label: t('tl_resume', { defaultValue: 'Reprendre toute la chronologie' }), icon: <Play size={14} />,
      onClick: () => onAction({ action: 'tip', id: null }),
    }] : []),
    { type: 'separator' },
    {
      type: 'action', label: t('delete', { defaultValue: 'Supprimer' }), icon: <Trash2 size={14} />, danger: true,
      onClick: () => onAction({ action: 'delete', id: it.id }),
    },
  ]

  return (
    <div className="absolute left-3 top-3 bottom-16 w-56 flex flex-col pointer-events-none">
      <div className="pointer-events-auto rounded-xl border border-border bg-surface-1/95 backdrop-blur shadow-lg overflow-hidden flex flex-col max-h-full">
        <div className="flex items-center gap-1.5 px-3 h-8 border-b border-border shrink-0">
          <Shapes size={13} className="text-text-tertiary" />
          <span className="text-[11px] font-semibold text-text-primary">
            {t('tl_title', { defaultValue: 'Historique' })}
          </span>
          <span className="ml-auto text-[10px] text-text-tertiary">{items.length}</span>
        </div>
        {items.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-text-tertiary">
            {t('tl_empty', { defaultValue: 'Esquissez une forme pour commencer.' })}
          </div>
        ) : (
          <div className="overflow-y-auto py-1">
            {items.map(it => (
              <div key={it.id}>
                <button
                  className={`w-full flex items-center gap-2 px-2.5 h-7 text-left text-[11px] transition-colors
                    ${it.selected ? 'bg-accent/15 text-text-primary' : 'text-text-secondary hover:bg-surface-2'}
                    ${!it.computed ? 'opacity-45' : ''}`}
                  onClick={e => onAction({ action: 'select', id: it.id, additive: e.shiftKey || e.ctrlKey || e.metaKey })}
                  onDoubleClick={() => { setRenaming(it.id); setDraft(it.name) }}
                  onContextMenu={e => { e.preventDefault(); setMenuFor(it); menu.open(e) }}
                  title={it.error}
                >
                  <span className={it.selected ? 'text-accent' : 'text-text-tertiary'}>
                    {TYPE_ICONS[it.type] ?? <Box size={13} />}
                  </span>
                  {renaming === it.id ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={e => setDraft(e.target.value)}
                      onBlur={() => commitRename(it.id)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitRename(it.id)
                        else if (e.key === 'Escape') setRenaming(null)
                      }}
                      onClick={e => e.stopPropagation()}
                      className="flex-1 min-w-0 h-5 px-1 rounded border border-border bg-surface-2 text-[11px] text-text-primary"
                    />
                  ) : (
                    <span className={`flex-1 truncate ${it.suppressed ? 'line-through' : ''}`}>{it.name}</span>
                  )}
                  {it.error && <AlertTriangle size={12} className="text-amber-500 shrink-0" />}
                  {it.consumed && !it.error && <EyeOff size={11} className="text-text-tertiary/70 shrink-0" />}
                </button>
                {/* Rollback bar: everything after this line is not computed. */}
                {it.isTip && <div className="mx-2 my-0.5 h-0.5 rounded bg-accent/70" />}
              </div>
            ))}
          </div>
        )}
      </div>
      {menu.isOpen && menu.pos && menuFor && (
        <MenuDropdown items={menuItems(menuFor)} pos={menu.pos} onClose={() => { menu.close(); setMenuFor(null) }} />
      )}
    </div>
  )
}
