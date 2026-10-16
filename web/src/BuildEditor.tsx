import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { WorkspaceTheme } from '@kubuno/sdk'
import type { StartPageRecentItem } from '@ui'
import { useSaveShortcut } from '@ui'
import { ModuleStartPage, type FileItem } from '@kubuno/drive'
import {
  MousePointer2, Trash2, Maximize, Boxes, Map, Plus,
  ExternalLink, Copy, FileJson, Image as ImageIcon,
  Grid2x2, Package,
} from 'lucide-react'
import { OfficeShell } from './shell/OfficeShell'
import { SaveButton } from './ribbon/SaveButton'
import { UndoRedoButtons } from './ribbon/UndoRedoButtons'
import { clipboardGroup } from './ribbon/clipboardGroup'
import { backstageLabels, BackstageInfo, ModuleHome, useFileTab } from './ribbon/ModuleBackstage'
import { useOpenError } from './ribbon/useOpenError'
import type { RibbonGroup, RibbonItem, RibbonTab } from './ribbon/types'
import { Viewport3D, type ViewportHandle } from './Viewport3D'
import { TimelinePanel, type TimelineAction } from './TimelinePanel'
import { buildApi, DEFAULT_PUBLIC_CONFIG, loadPublicConfig, type BuildPublicConfig } from './api'
import type { BuildDocument, BuildDocumentSummary, DocKind } from './types'
import type { BuildEngine, EditorController, EngineFactory, SelectionInfo, SelField, SketchStatus, TimelineItem } from './engine'

// Generic editor shell for both Build sub-apps, aligned on the Office editors:
// - route WITHOUT :id → ModuleHome (chrome with a locked « Fichier » backstage =
//   the sub-app start page: recents + create).
// - route WITH :id → the full editor whose ribbon starts with the « Fichier »
//   backstage tab (useFileTab), followed by Accueil (edit + app tools + view)
//   and the app-specific extra tabs.
// Each sub-app injects its modeling `engine` plus its ribbon groups; the engine
// owns everything three.js.
export function BuildEditor({
  kind,
  theme,
  accent,
  icon,
  appLabel,
  newLabel,
  viewportMode,
  gridExtentMm,
  gridCellMm,
  gridStepMm,
  background,
  gridColor,
  gradient,
  gridIn3d,
  showViewToggle,
  navCube,
  orthoToggle,
  meshExports,
  prepare,
  createEngine,
  homeGroups,
  extraTabs,
}: {
  kind: DocKind
  theme: WorkspaceTheme
  accent: string
  /** Sub-app icon (topbar + recents). */
  icon: ReactNode
  /** Sub-app display name (« Architect » / « CAO3D »). */
  appLabel: string
  /** Label of the create action (« Nouveau bâtiment » / « Nouvelle pièce »). */
  newLabel: string
  viewportMode: '2d' | '3d'
  gridExtentMm: number
  gridCellMm: number
  gridStepMm: number
  background?: number
  gridColor?: number
  /** Vertical background gradient [top, bottom] (Fusion-style backdrop). */
  gradient?: [number, number]
  /** Keep the sketch grid visible in 3D (CAD mode) with a shadow-catcher floor. */
  gridIn3d?: boolean
  showViewToggle?: boolean
  /** Corner navigation cube in the 3D view. */
  navCube?: boolean
  /** Perspective/orthographic toggle in the Affichage group. */
  orthoToggle?: boolean
  /** STL / GLB exports in the backstage (engine must expose exportSolids). */
  meshExports?: boolean
  /** Async prerequisite resolved before the engine is built (WASM kernel…). */
  prepare?: () => Promise<void>
  createEngine: EngineFactory
  /** App tool groups inserted in the Accueil tab (between Édition and Affichage). */
  homeGroups: (ctrl: EditorController) => RibbonGroup[]
  /** Additional app tabs after Accueil (Insertion, Solide…). */
  extraTabs?: (ctrl: EditorController) => RibbonTab[]
}) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { t, i18n } = useTranslation('build')
  const { showOpenError, openErrorDialog } = useOpenError(t)

  const [doc, setDoc] = useState<BuildDocument | null>(null)
  const [docs, setDocs] = useState<BuildDocumentSummary[]>([])
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [tool, setToolState] = useState('select')
  const [view, setViewState] = useState<'2d' | '3d'>(viewportMode)
  const [hasSelection, setHasSelection] = useState(false)
  const [selInfo, setSelInfo] = useState<SelectionInfo | null>(null)
  const [history, setHistory] = useState({ canUndo: false, canRedo: false })
  const [timeline, setTimeline] = useState<TimelineItem[] | null>(null)
  const [sketchStatus, setSketchStatus] = useState<SketchStatus | null>(null)
  const [ortho3d, setOrtho3d] = useState(false)
  const [ready, setReady] = useState(!prepare)
  // Instance settings the administrator publishes for the editors (default unit
  // of a new document, auto-save cadence). Kept at the factory defaults until
  // the read resolves, so nothing waits on it.
  const [instanceConfig, setInstanceConfig] = useState<BuildPublicConfig>(DEFAULT_PUBLIC_CONFIG)

  useEffect(() => {
    let cancelled = false
    loadPublicConfig().then(cfg => { if (!cancelled) setInstanceConfig(cfg) })
    return () => { cancelled = true }
  }, [])

  // Await the engine prerequisite (e.g. the Manifold WASM kernel) once.
  useEffect(() => {
    if (!prepare) return
    let cancelled = false
    prepare().then(() => { if (!cancelled) setReady(true) })
    return () => { cancelled = true }
  }, [prepare])

  const engineRef = useRef<BuildEngine | null>(null)
  const handleRef = useRef<ViewportHandle | null>(null)
  const docRef = useRef<BuildDocument | null>(null)
  docRef.current = doc

  // Open the routed document; recents feed the start page + backstage Accueil.
  useEffect(() => {
    if (!id) { setDoc(null); return }
    let cancelled = false
    buildApi.get(id)
      .then(d => { if (!cancelled) { setDoc(d); setTitleDraft(d.title) } })
      .catch(err => { if (!cancelled) showOpenError(err) })
    return () => { cancelled = true }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const refreshDocs = useCallback(() => {
    buildApi.list(kind).then(setDocs).catch(() => {})
  }, [kind])
  useEffect(() => { refreshDocs() }, [refreshDocs])

  // Build the engine once the viewport is ready AND the document is loaded.
  const onViewportReady = useCallback((handle: ViewportHandle) => {
    const current = docRef.current
    if (!current) return
    handleRef.current = handle
    engineRef.current?.dispose()
    engineRef.current = createEngine({
      handle,
      unit: current.unit,
      accent,
      gridStepMm,
      initialData: current.data,
      onDirty: () => setDirty(true),
      onSelectionChange: setHasSelection,
      onSelectionInfo: setSelInfo,
      onToolChange: setToolState,
      onHistoryChange: (canUndo, canRedo) => setHistory({ canUndo, canRedo }),
      onTimelineChange: setTimeline,
      onSketchStatus: setSketchStatus,
      tr: (key, fallback) => t(key, { defaultValue: fallback }),
    })
    engineRef.current.setView(viewportMode)
    setToolState('select'); setViewState(viewportMode); setSelInfo(null); setDirty(false)
  }, [createEngine, gridStepMm, viewportMode, accent, t])

  useEffect(() => () => { engineRef.current?.dispose(); engineRef.current = null }, [])

  const setTool = useCallback((next: string) => { setToolState(next); engineRef.current?.setTool(next) }, [])
  const setView = useCallback((next: '2d' | '3d') => { setViewState(next); engineRef.current?.setView(next) }, [])
  const deleteSelection = useCallback(() => engineRef.current?.deleteSelection(), [])
  const copySelection = useCallback(() => engineRef.current?.copySelection(), [])
  const cutSelection = useCallback(() => engineRef.current?.cutSelection(), [])
  const paste = useCallback(() => engineRef.current?.paste(), [])
  const fitView = useCallback(() => engineRef.current?.fitView(), [])
  const undo = useCallback(() => engineRef.current?.undo(), [])
  const redo = useCallback(() => engineRef.current?.redo(), [])
  const run = useCallback((command: string, payload?: unknown) => engineRef.current?.command(command, payload), [])

  // Ctrl+S / ⌘S saves immediately.
  useSaveShortcut(() => { void save() })

  const save = useCallback(async () => {
    const current = docRef.current
    if (!current || !engineRef.current) return
    setSaving(true)
    try {
      const data = engineRef.current.serialize()
      await buildApi.update(current.id, { data })
      setDoc({ ...current, data })
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }, [])

  // Auto-save: the instance sets the cadence (Build ▸ Édition ▸ Enregistrement);
  // 0 disables it, leaving Ctrl+S and the Enregistrer button as the only writes.
  // Refs, not deps, so a keystroke does not restart the timer.
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const savingRef = useRef(false)
  savingRef.current = saving

  useEffect(() => {
    const period = instanceConfig.autosaveIntervalS
    if (!id || period <= 0) return
    const timer = window.setInterval(() => {
      if (dirtyRef.current && !savingRef.current) void save()
    }, period * 1000)
    return () => { window.clearInterval(timer) }
  }, [id, instanceConfig.autosaveIntervalS, save])

  const commitTitle = useCallback(async () => {
    const current = docRef.current
    if (!current) return
    const v = titleDraft.trim()
    if (v && v !== current.title) {
      const updated = await buildApi.update(current.id, { title: v })
      setDoc(updated); setTitleDraft(updated.title); refreshDocs()
    } else if (!v) {
      setTitleDraft(current.title)
    }
  }, [titleDraft, refreshDocs])

  // ---- Start page (recents + create) - landing AND backstage Accueil -------
  const createDoc = useCallback(async () => {
    // The instance decides the metric unit a new document opens in.
    const created = await buildApi.create({ kind, title: newLabel, unit: instanceConfig.defaultUnit })
    navigate(`/build/${kind}/${created.id}`)
  }, [kind, newLabel, navigate, instanceConfig.defaultUnit])

  const recentItems: StartPageRecentItem[] = useMemo(() => docs.slice(0, 16).map(d => ({
    id: d.id,
    name: d.title,
    subtitle: new Date(d.updated_at).toLocaleDateString(i18n.language || 'fr-FR'),
    icon: <span className="text-text-tertiary [&>svg]:w-[18px] [&>svg]:h-[18px]">{icon}</span>,
    onClick: () => navigate(`/build/${kind}/${d.id}`),
    actions: [
      { id: 'open', label: t('open', { defaultValue: 'Ouvrir' }), icon: <ExternalLink size={15} />, onClick: () => navigate(`/build/${kind}/${d.id}`) },
      { id: 'dup', label: t('duplicate', { defaultValue: 'Dupliquer' }), icon: <Copy size={15} />, onClick: () => { void buildApi.duplicate(d.id).then(nd => navigate(`/build/${kind}/${nd.id}`)) } },
      { id: 'trash', label: t('move_to_trash', { defaultValue: 'Mettre à la corbeille' }), icon: <Trash2 size={15} />, danger: true, onClick: () => { void buildApi.trash(d.id).then(refreshDocs) } },
    ],
  })), [docs, icon, kind, navigate, refreshDocs, t, i18n.language])

  // Files double-clicked in the drive browser resolve to a document (imported
  // on the fly server-side if the .kb*** has no linked row yet).
  const handleOpenFile = useCallback((file: FileItem): boolean => {
    buildApi.openByFile(file.id)
      .then(opened => navigate(`/build/${kind}/${opened.id}`))
      .catch(showOpenError)
    return true
  }, [kind, navigate, showOpenError])

  const startContent = (
    <ModuleStartPage
      recentTitle={t('recent', { defaultValue: 'Récents' })}
      recentItems={recentItems}
      recentEmpty={
        <div className="flex flex-col items-center gap-2">
          <span className="text-text-tertiary opacity-40 [&>svg]:w-8 [&>svg]:h-8">{icon}</span>
          <p className="text-text-tertiary text-xs">{t('start_empty', { defaultValue: 'Créez un document ou ouvrez-en un récent' })}</p>
        </div>
      }
      browse={{
        folderPathPrefix: kind === 'cao3d' ? 'Build/CAO3D' : 'Build/Architect',
        title: appLabel,
        fileTypeModuleId: `build-${kind}`,
        onOpenFile: handleOpenFile,
        toolbarContent: (
          <button onClick={() => { void createDoc() }}
            className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-medium text-white transition-opacity hover:opacity-90"
            style={{ background: accent }}>
            <Plus size={15} /> {newLabel}
          </button>
        ),
      }}
    />
  )

  // ---- « Fichier » backstage tab (Office-style) -----------------------------
  const exportJson = useCallback(() => {
    const current = docRef.current
    if (!current || !engineRef.current) return
    const blob = new Blob([JSON.stringify(engineRef.current.serialize(), null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${current.title || 'document'}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [])

  const exportMesh = useCallback(async (format: 'stl' | 'glb') => {
    const current = docRef.current
    const root = engineRef.current?.exportSolids?.()
    if (!current || !root) return
    const { toBinaryStl, toGlb, downloadBytes } = await import('./exporters')
    const name = current.title || 'document'
    if (format === 'stl') downloadBytes(toBinaryStl(root), `${name}.stl`, 'model/stl')
    else downloadBytes(await toGlb(root), `${name}.glb`, 'model/gltf-binary')
  }, [])

  const exportPng = useCallback(() => {
    const h = handleRef.current
    const current = docRef.current
    if (!h || !current) return
    // Render synchronously right before reading the buffer (no preserveDrawingBuffer).
    h.renderer.render(h.scene, h.camera)
    const a = document.createElement('a')
    a.href = h.renderer.domElement.toDataURL('image/png')
    a.download = `${current.title || 'document'}.png`
    a.click()
  }, [])

  const { fileTab, activeTabId, onTabChange } = useFileTab({
    theme,
    labels: backstageLabels(t),
    startContent,
    openKey: id ?? null,
    doc: doc ? {
      info: (
        <BackstageInfo
          title={titleDraft}
          onTitleChange={setTitleDraft}
          onTitleCommit={() => { void commitTitle() }}
          extension={kind === 'cao3d' ? '.kbcao' : '.kbarch'}
          subtitle={appLabel}
          general={[
            [t('bs_type', { defaultValue: 'Type' }), appLabel],
            [t('bs_unit', { defaultValue: 'Unité' }), doc.unit],
            [t('bs_modified', { defaultValue: 'Modifié le' }), new Date(doc.updated_at).toLocaleDateString(i18n.language || 'fr-FR')],
          ]}
        />
      ),
      exports: [
        { icon: <ImageIcon size={20} />, label: t('export_png', { defaultValue: 'Image (PNG)' }), sub: t('export_png_sub', { defaultValue: 'Capture de la vue 3D' }), onClick: exportPng },
        { icon: <FileJson size={20} />, label: t('export_json', { defaultValue: 'Modèle (JSON)' }), sub: t('export_json_sub', { defaultValue: 'Données brutes du modèle' }), onClick: exportJson },
        ...(meshExports ? [
          { icon: <Package size={20} />, label: t('export_stl', { defaultValue: 'Maillage (STL)' }), sub: t('export_stl_sub', { defaultValue: 'Impression 3D' }), onClick: () => { void exportMesh('stl') } },
          { icon: <Package size={20} />, label: t('export_glb', { defaultValue: 'Scène (GLB)' }), sub: t('export_glb_sub', { defaultValue: 'glTF binaire, visionneuses 3D' }), onClick: () => { void exportMesh('glb') } },
        ] : []),
      ],
      onClose: () => navigate(`/build/${kind}`),
    } : undefined,
  })

  // ---- Ribbon ---------------------------------------------------------------
  const sketchActive = sketchStatus != null
  const ctrl: EditorController = useMemo(() => ({
    tool, setTool, view, setView,
    hasSelection, deleteSelection, fitView,
    undo, redo, canUndo: history.canUndo, canRedo: history.canRedo,
    sketchActive, run,
  }), [tool, setTool, view, setView, hasSelection, deleteSelection, fitView, undo, redo, history, sketchActive, run])

  const ribbon: RibbonTab[] = useMemo(() => {
    // Clipboard (shared helper) - ALWAYS the first group of the Home tab.
    // Undo/Redo are NOT in the ribbon: they live in the tab strip
    // (`UndoRedoButtons`, see `titleActions`).
    const clipGroup: RibbonGroup = clipboardGroup({
      t,
      onPaste: paste,
      onCut: cutSelection, cutDisabled: !hasSelection,
      onCopy: copySelection, copyDisabled: !hasSelection,
    })
    const editGroup: RibbonGroup = {
      id: 'edit', label: t('grp_edit', { defaultValue: 'Édition' }),
      items: [
        {
          id: 'select', kind: 'toggle', size: 'large',
          label: t('tool_select', { defaultValue: 'Sélection' }),
          icon: <MousePointer2 size={18} />, active: tool === 'select',
          onClick: () => setTool('select'),
        },
        {
          id: 'delete', kind: 'button', label: t('delete', { defaultValue: 'Supprimer' }),
          icon: <Trash2 size={18} />, disabled: !hasSelection, onClick: deleteSelection,
        },
      ],
    }
    const viewItems: RibbonItem[] = [
      { id: 'fit', kind: 'button', label: t('view_fit', { defaultValue: 'Recentrer' }), icon: <Maximize size={18} />, onClick: fitView },
    ]
    if (orthoToggle) {
      viewItems.push({
        id: 'ortho', kind: 'toggle', label: t('view_ortho', { defaultValue: 'Ortho' }),
        icon: <Grid2x2 size={18} />, active: ortho3d,
        onClick: () => { const next = !ortho3d; setOrtho3d(next); run('view.ortho', { on: next }) },
      })
    }
    if (showViewToggle) {
      viewItems.unshift(
        { id: 'v2d', kind: 'toggle', label: t('view_2d', { defaultValue: 'Plan 2D' }), icon: <Map size={18} />, active: view === '2d', onClick: () => setView('2d') },
        { id: 'v3d', kind: 'toggle', label: t('view_3d', { defaultValue: 'Vue 3D' }), icon: <Boxes size={18} />, active: view === '3d', onClick: () => setView('3d') },
      )
    }
    const viewGroup: RibbonGroup = { id: 'view', label: t('grp_view', { defaultValue: 'Affichage' }), items: viewItems }
    const home: RibbonTab = {
      id: 'home', label: t('tab_home', { defaultValue: 'Accueil' }),
      groups: [clipGroup, editGroup, ...homeGroups(ctrl), viewGroup],
    }
    return [fileTab, home, ...(extraTabs ? extraTabs(ctrl) : [])]
  }, [t, tool, hasSelection, deleteSelection, copySelection, cutSelection, paste, fitView, showViewToggle, view, setView, setTool, homeGroups, extraTabs, ctrl, fileTab])

  // The contextual « Esquisse » tab appears when the sketch editor opens -
  // switch to it automatically, and back to Accueil when the sketch closes.
  const prevSketchActive = useRef(false)
  useEffect(() => {
    if (sketchActive === prevSketchActive.current) return
    prevSketchActive.current = sketchActive
    onTabChange(sketchActive ? 'sketch' : 'home')
  }, [sketchActive, onTabChange])

  // ---- Landing (no :id in the route) - Office-style ModuleHome --------------
  if (!id) {
    return (
      <>
        {openErrorDialog}
        <ModuleHome
          theme={theme}
          title={appLabel}
          titleIcon={<span className="text-white/90 flex-shrink-0 [&>svg]:w-4 [&>svg]:h-4">{icon}</span>}
          fileLabel={t('office_bs_file', { defaultValue: 'Fichier' })}
          homeLabel={t('office_bs_home', { defaultValue: 'Accueil' })}
          startContent={startContent}
          onBack={() => navigate('/build')}
        />
      </>
    )
  }

  return (
    <>
    {openErrorDialog}
    <OfficeShell
      ribbon={ribbon}
      activeTabId={activeTabId}
      onTabChange={onTabChange}
      chromeless
      showSearch={false}
      topbarHeight={64}
      theme={theme}
      titleIcon={<span className="text-white/90 flex-shrink-0 [&>svg]:w-4 [&>svg]:h-4">{icon}</span>}
      title={titleDraft}
      onTitleChange={setTitleDraft}
      onTitleCommit={() => { void commitTitle() }}
      titlePlaceholder={t('untitled', { defaultValue: 'Sans titre' })}
      onDelete={() => { void buildApi.trash(id).then(() => navigate(`/build/${kind}`)) }}
      deleteTitle={t('move_to_trash', { defaultValue: 'Mettre à la corbeille' })}
      titleActions={
        <div className="flex items-center gap-1">
          <SaveButton onSave={() => { void save() }} saving={saving} dirty={dirty} label={t('save', { defaultValue: 'Enregistrer' })} />
          <UndoRedoButtons
            onUndo={undo} onRedo={redo} canUndo={history.canUndo} canRedo={history.canRedo}
            undoLabel={t('undo', { defaultValue: 'Annuler' })} redoLabel={t('redo', { defaultValue: 'Rétablir' })}
          />
        </div>
      }
    >
      <div className="w-full h-full relative">
        {doc && ready && (
          <Viewport3D
            key={doc.id} // remount per document (backstage can navigate between docs)
            mode={viewportMode}
            accent={accent}
            gridExtentMm={gridExtentMm}
            gridCellMm={gridCellMm}
            background={background}
            gridColor={gridColor}
            gradient={gradient}
            gridIn3d={gridIn3d}
            navCube={navCube}
            onReady={onViewportReady}
          />
        )}
        {timeline && (
          <TimelinePanel
            items={timeline}
            onAction={(a: TimelineAction) => {
              if (a.action === 'select') run('feat.select', { id: a.id, additive: a.additive })
              else if (a.action === 'edit') run('sketch.edit', { id: a.id })
              else if (a.action === 'rename') run('feat.rename', { id: a.id, name: a.name })
              else if (a.action === 'suppress') run('feat.suppress', { id: a.id })
              else if (a.action === 'delete') run('feat.delete', { id: a.id })
              else if (a.action === 'tip') run('feat.tip', { id: a.id })
            }}
          />
        )}
        <ToolHint kind={kind} tool={tool} />
        {sketchStatus && <SketchChip status={sketchStatus} />}
        {selInfo && (
          <PropertiesPanel
            info={selInfo}
            side={timeline ? 'right' : 'left'} // keep clear of the timeline panel
            onEdit={(key, value) => run('setProp', { key, value })}
          />
        )}
      </div>
    </OfficeShell>
    </>
  )
}

// Floating panel (bottom-left of the viewport) that edits the numeric dimensions
// of the selected element. Each field commits on blur / Enter; the engine
// re-emits the info so values stay in sync after every edit.
function PropertiesPanel({ info, onEdit, side = 'left' }: { info: SelectionInfo; onEdit: (key: string, value: number) => void; side?: 'left' | 'right' }) {
  return (
    <div className={`absolute ${side === 'right' ? 'right-4' : 'left-4'} bottom-4 min-w-[200px] rounded-xl border border-border bg-surface-1/95 backdrop-blur shadow-lg p-3 pointer-events-auto`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-text-primary">{info.title}</span>
        {info.count && info.count > 1 && (
          <span className="text-[10px] font-medium text-text-secondary px-1.5 py-0.5 rounded bg-surface-2">{info.count} sél.</span>
        )}
      </div>
      {info.fields.length === 0 ? (
        <div className="text-[11px] text-text-tertiary">Aucun paramètre.</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {info.fields.map(f => <PropField key={f.key} field={f} onEdit={onEdit} />)}
        </div>
      )}
    </div>
  )
}

function PropField({ field, onEdit }: { field: SelField; onEdit: (key: string, value: number) => void }) {
  const shown = Math.round(field.value * 1000) / 1000
  const [text, setText] = useState(String(shown))
  // Reseed when the underlying value changes (e.g. after undo or another edit).
  const seed = useRef(shown)
  if (seed.current !== shown) { seed.current = shown; if (Number(text) !== shown) setText(String(shown)) }
  const commit = () => {
    const v = Number(text.replace(',', '.'))
    if (Number.isFinite(v) && v !== field.value) onEdit(field.key, Math.max(field.min ?? -Infinity, v))
  }
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span className="text-text-secondary">{field.label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number" value={text} step={field.step ?? 1} min={field.min}
          onChange={e => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur() } }}
          className="w-20 h-7 px-1.5 rounded-md border border-border bg-surface-2 text-text-primary text-xs text-right"
        />
        {field.unit && <span className="text-text-tertiary w-4">{field.unit}</span>}
      </span>
    </label>
  )
}

// Solver status while editing a sketch (FreeCAD's DoF readout): green when the
// sketch is fully constrained, red on conflicting constraints, neutral count of
// the remaining degrees of freedom otherwise.
function SketchChip({ status }: { status: SketchStatus }) {
  const { t } = useTranslation('build')
  let cls = 'bg-black/55 text-white/90'
  let text = t('sk_dof', { defaultValue: '{{n}} degrés de liberté', n: status.dof })
  if (!status.solved || status.conflicting > 0) {
    cls = 'bg-red-600/85 text-white'
    text = status.conflicting > 0
      ? t('sk_conflicts', { defaultValue: '{{n}} contrainte(s) en conflit', n: status.conflicting })
      : t('sk_unsolved', { defaultValue: 'Contraintes insolubles' })
  } else if (status.dof === 0) {
    cls = 'bg-emerald-600/85 text-white'
    text = t('sk_full', { defaultValue: 'Esquisse totalement contrainte' })
  }
  return (
    <div className={`absolute left-1/2 -translate-x-1/2 top-3 px-3 py-1.5 rounded-full text-xs font-medium backdrop-blur pointer-events-none ${cls}`}>
      {text}
    </div>
  )
}

// Small contextual hint at the bottom of the viewport telling the user what the
// active tool expects (click to place, Esc to finish…).
function ToolHint({ kind, tool }: { kind: DocKind; tool: string }) {
  const { t } = useTranslation('build')
  if (tool === 'select') return null
  const hint = t(`hint_${kind}_${tool}`, { defaultValue: t(`hint_${tool}`, { defaultValue: '' }) })
  if (!hint) return null
  return (
    <div className="absolute left-1/2 -translate-x-1/2 bottom-4 px-3 py-1.5 rounded-full text-xs font-medium text-white/90 bg-black/55 backdrop-blur pointer-events-none">
      {hint}
    </div>
  )
}
