// OfficeShell - la chrome COMMUNE à tous les sous-éditeurs Office, qui remplace la
// barre de menus + la toolbar par un RUBAN (façon MS Office). Enveloppe le
// `WorkspaceShell` du core : reprend toutes ses props (topbar, titre, retour, thème,
// actions, statut, rail, bottom/status bar, corps…) et rend le ruban dans le slot
// `menuBar` du shell (donc `menuBar`/`menus`/`optionsBar` ne sont PAS exposés ici :
// le ruban les remplace). Chaque sous-éditeur fournit sa config `ribbon: RibbonTab[]`.
import { useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Trash2, Maximize2, Minimize2 } from 'lucide-react'
import { WorkspaceShell, WORKSPACE_OFFICE, useConfirm } from '@kubuno/sdk'
import { ConfirmDialog } from '@ui'
import { Ribbon, RibbonTabStrip } from '../ribbon/Ribbon'
import type { RibbonTab, RibbonGroup, RibbonItem } from '../ribbon/types'

// Réduction du ruban (façon MS Office) - PRÉFIXE de clé : suffixée par le sous-module
// (cf. `ribbonKey`) → persistance PAR sous-module. Défaut = déplié.
const RIBBON_COLLAPSED_KEY = 'kubuno.ribbon.collapsed'

// Garantit, pour TOUT ruban, un onglet « Affichage » → groupe « Afficher » → bouton
// « Plein écran » (Fullscreen API, façon F11). Ajoute sans doublon si déjà présent.
function ensureFullscreenView(
  tabs: RibbonTab[],
  labels: { view: string; show: string; full: string },
  isFullscreen: boolean,
  toggle: () => void,
): RibbonTab[] {
  if (!tabs.length) return tabs
  const fsBtn: RibbonItem = {
    id: 'fullscreen', kind: 'toggle', size: 'large',
    icon: isFullscreen ? <Minimize2 size={22} /> : <Maximize2 size={22} />,
    label: labels.full, tooltip: labels.full, shortcut: 'F11',
    active: isFullscreen, onClick: toggle,
  }
  const isView = (tb: RibbonTab) => tb.backstage == null && (tb.id === 'view' || /^affichage$/i.test(tb.label.trim()))
  const isShow = (g: RibbonGroup) => g.id === 'show' || /^afficher$/i.test(g.label.trim())
  const addToShow = (groups: RibbonGroup[]): RibbonGroup[] => {
    const gi = groups.findIndex(isShow)
    if (gi >= 0) {
      if (groups[gi].items.some(it => it.id === 'fullscreen')) return groups
      const ng = groups.slice(); ng[gi] = { ...ng[gi], items: [...ng[gi].items, fsBtn] }; return ng
    }
    return [{ id: 'show', label: labels.show, items: [fsBtn] }, ...groups]
  }
  const vi = tabs.findIndex(isView)
  if (vi >= 0) {
    const nt = tabs.slice(); nt[vi] = { ...nt[vi], groups: addToShow(nt[vi].groups) }; return nt
  }
  const newTab: RibbonTab = { id: 'view', label: labels.view, groups: [{ id: 'show', label: labels.show, items: [fsBtn] }] }
  const ci = tabs.findIndex(tb => tb.contextual)
  const nt = tabs.slice()
  if (ci >= 0) nt.splice(ci, 0, newTab); else nt.push(newTab)
  return nt
}

type ShellProps = ComponentProps<typeof WorkspaceShell>
// On retire les slots remplacés par le ruban.
type OfficeShellProps = Omit<ShellProps, 'menuBar' | 'menus' | 'menuActions' | 'optionsBar' | 'optionsBarHeight'> & {
  ribbon: RibbonTab[]
  activeTabId?: string
  onTabChange?: (id: string) => void
}

export function OfficeShell({ ribbon, activeTabId, onTabChange, theme = WORKSPACE_OFFICE, onBack, ...rest }: OfficeShellProps) {
  // Bouton « retour » volontairement retiré de TOUS les éditeurs à ruban : on ne
  // transmet pas `onBack` au WorkspaceShell (la prop reste acceptée pour compat des
  // appelants, mais n'affiche plus de flèche dans la topbar).
  void onBack
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
  const { pathname } = useLocation()

  // Onglet actif : contrôlé par l'éditeur si fourni, sinon état local (la bande
  // d'onglets vit dans la TOPBAR et doit rester synchronisée avec le ruban).
  const [ownTab, setOwnTab] = useState(() => ribbon.find(t => t.visible !== false)?.id ?? '')
  const activeTab = activeTabId ?? ownTab
  const changeTab = useCallback((id: string) => { onTabChange?.(id); if (activeTabId === undefined) setOwnTab(id) }, [onTabChange, activeTabId])

  // ── Plein écran (F11) - bouton garanti dans Affichage → Afficher de TOUT ruban ──
  const { t } = useTranslation()
  const [isFullscreen, setIsFullscreen] = useState(() => typeof document !== 'undefined' && !!document.fullscreenElement)
  useEffect(() => {
    const on = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen?.()
    else document.documentElement.requestFullscreen?.()
  }, [])
  const nribbon = useMemo(() => ensureFullscreenView(ribbon, {
    view: t('office_tab_view',          { defaultValue: 'Affichage' }),
    show: t('office_grp_show',          { defaultValue: 'Afficher' }),
    full: t('office_ribbon_fullscreen', { defaultValue: 'Plein écran' }),
  }, isFullscreen, toggleFullscreen), [ribbon, isFullscreen, t, toggleFullscreen])

  // ── Réduction du ruban + « peek » (façon MS Office) ─────────────────────────────
  // Persistance PAR sous-module (clé dérivée du chemin sans l'id de document). Défaut = déplié.
  const ribbonKey = RIBBON_COLLAPSED_KEY + ':' + (pathname.split('/').filter(Boolean)
    .filter(s => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)).join('/') || 'root')
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(ribbonKey) === '1' } catch { return false } })
  const [peekOpen, setPeekOpen] = useState(false)
  useEffect(() => { try { setCollapsed(localStorage.getItem(ribbonKey) === '1') } catch { /* ignore */ } }, [ribbonKey])
  const toggleCollapsed = useCallback(() => {
    setCollapsed(c => { const n = !c; try { localStorage.setItem(ribbonKey, n ? '1' : '0') } catch { /* ignore */ } return n })
  }, [ribbonKey])
  useEffect(() => { setPeekOpen(false) }, [collapsed])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.ctrlKey && (e.key === 'F1' || e.code === 'F1')) { e.preventDefault(); toggleCollapsed() } }
    const onStorage = (e: StorageEvent) => { if (e.key === ribbonKey) setCollapsed(e.newValue === '1') }
    window.addEventListener('keydown', onKey)
    window.addEventListener('storage', onStorage)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('storage', onStorage) }
  }, [toggleCollapsed, ribbonKey])

  const fileTabId = nribbon.find(t => t.backstage != null)?.id
  const backstageOpen = activeTab === fileTabId && fileTabId != null
  const peeking = collapsed && peekOpen && !backstageOpen
  const closePeek = useCallback(() => setPeekOpen(false), [])
  const handleTab = (id: string) => {
    if (id === fileTabId) { changeTab(id); setPeekOpen(false); return }
    if (collapsed) {
      const closing = peekOpen && activeTab === id
      changeTab(id)
      setPeekOpen(!closing)
    } else {
      changeTab(id)
    }
  }
  const stripActive = (collapsed && !peekOpen && !backstageOpen) ? undefined : activeTab

  // Le bloc d'actions de titre (Enregistrer/Annuler/Rétablir/étoile) et la corbeille
  // quittent le topbar pour la BANDE D'ONGLETS du ruban, juste après « Fichier ».
  const { titleActions, onDelete, deleteConfirm, deleteTitle } = rest as ShellProps
  const triggerDelete = async () => {
    if (!onDelete) return
    const ok = await confirm(deleteConfirm ?? { title: 'Supprimer ?', message: 'Cette action est irréversible.', confirmLabel: 'Supprimer', variant: 'danger' })
    if (ok) onDelete()
  }
  const ribbonActions = (titleActions || onDelete) ? (
    <>
      {titleActions}
      {onDelete && (
        <button onClick={triggerDelete} title={deleteTitle}
          className="p-1.5 rounded hover:bg-white/10 transition-colors flex-shrink-0 text-white/90">
          <Trash2 size={15} />
        </button>
      )}
    </>
  ) : null

  // On retire du forward vers le WorkspaceShell (a) le bloc d'actions (déplacé dans la
  // bande d'onglets) et (b) le TITRE + son icône (le nom se modifie dans Informations).
  const forwarded: ShellProps = { ...(rest as ShellProps) }
  delete forwarded.titleActions
  delete forwarded.onDelete
  delete forwarded.deleteConfirm
  delete forwarded.deleteTitle
  delete forwarded.title
  delete forwarded.titleIcon
  delete forwarded.onTitleChange
  delete forwarded.onTitleCommit
  delete forwarded.titlePlaceholder
  // Bande d'onglets DANS la topbar : la rangée dédiée du ruban disparaît (30px gagnés) ;
  // en mode recherche, l'overlay de la topbar recouvre les onglets sans rien décaler.
  forwarded.titleSlot = (
    <RibbonTabStrip
      tabs={nribbon} theme={theme} activeId={stripActive} onSelect={handleTab}
      tabStripActions={ribbonActions} inTopbar height={(rest as ShellProps).topbarHeight ?? 40}
      collapsed={collapsed} onToggleCollapsed={toggleCollapsed}
    />
  )

  return (
    <>
      <WorkspaceShell
        {...forwarded}
        theme={theme}
        menuBar={<Ribbon tabs={nribbon} theme={theme} activeTabId={activeTab} onTabChange={changeTab} hideTabs
                         collapsed={collapsed} peeking={peeking} onClosePeek={closePeek} />}
      />
      {confirmState && <ConfirmDialog {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />}
    </>
  )
}
