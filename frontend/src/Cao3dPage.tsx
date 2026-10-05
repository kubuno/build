import { useCallback, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Square, Circle, Spline, Box, RotateCcw, Layers,
  SquaresUnite, SquaresSubtract, SquaresIntersect, Diff, Slice,
  Move3d, Rotate3d, MoveVertical,
  PenLine, Check, Dot, Magnet, MoveHorizontal, Equal, Ruler,
  AlignHorizontalDistributeCenter, CornerDownRight, LocateFixed, Minus,
  MousePointer2, Trash2,
  SquareMinus, Cylinder, Cone, Donut, FlipHorizontal, Grid3x3, RotateCw, Disc,
} from 'lucide-react'
import { BuildEditor } from './BuildEditor'
import { THEME_CAO3D } from './ribbon/officeThemes'
import type { RibbonGroup, RibbonTab } from './ribbon/types'
import type { EditorController, EngineContext } from './engine'
import { Cao3dEngine } from './Cao3dEngine'
import { initKernel } from './kernel'
import { initSketchSolver } from './sketchSolver'

/** Both WASM bricks load before the editor opens: Manifold (solids) + planegcs
 *  (sketch constraint solver). */
const prepare = () => Promise.all([initKernel(), initSketchSolver()]).then(() => {})

// CAO3D v2 — parametric editor à la FreeCAD/Fusion: sketches, features and
// combines live in a re-editable timeline (recomputed by the Manifold kernel).
// The ribbon is command-first: no inline number fields any more — every
// parameter (height, angle, radius…) is edited after the fact in the
// properties panel or the history panel, because nothing is destructive.
export default function Cao3dPage() {
  const { t } = useTranslation('build')

  const createEngine = useCallback((ctx: EngineContext) => new Cao3dEngine(ctx), [])

  const toolItem = (c: EditorController) => (id: string, label: string, icon: ReactNode, size?: 'large' | 'small') => ({
    id, kind: 'toggle' as const, size, label, icon, active: c.tool === id, onClick: () => c.setTool(id),
  })

  // Accueil — the everyday modeling flow: sketch a profile, turn it into a solid.
  const homeGroups = useCallback((c: EditorController): RibbonGroup[] => {
    const tool = toolItem(c)
    return [
      {
        id: 'sketch', label: t('cao_grp_sketch', { defaultValue: 'Esquisse' }),
        items: [
          tool('rect', t('cao_rect', { defaultValue: 'Rectangle' }), <Square size={18} />, 'large'),
          tool('circle', t('cao_circle', { defaultValue: 'Cercle' }), <Circle size={18} />, 'large'),
          tool('line', t('cao_poly', { defaultValue: 'Polyligne' }), <Spline size={18} />),
        ],
      },
      {
        id: 'create', label: t('cao_grp_create', { defaultValue: 'Créer' }),
        items: [
          {
            // Split: main action = pick a face (or the grid) with the pointer;
            // the menu offers the origin planes directly.
            id: 'newsketch', kind: 'split', size: 'large',
            label: t('sk_new', { defaultValue: 'Nouvelle esquisse' }), icon: <PenLine size={18} />,
            onClick: () => c.run('sketch.new'),
            splitItems: [
              { id: 'sk-pick', kind: 'button', label: t('sk_plane_pick', { defaultValue: 'Sur une face…' }), icon: <LocateFixed size={15} />, onClick: () => c.run('sketch.new') },
              { id: 'sk-ground', kind: 'button', label: t('sk_plane_ground', { defaultValue: 'Sol (XZ)' }), icon: <Square size={15} />, onClick: () => c.run('sketch.new', { plane: 'ground' }) },
              { id: 'sk-xy', kind: 'button', label: t('sk_plane_xy', { defaultValue: 'Frontal (XY)' }), icon: <Square size={15} />, onClick: () => c.run('sketch.new', { plane: 'xy' }) },
              { id: 'sk-yz', kind: 'button', label: t('sk_plane_yz', { defaultValue: 'Latéral (YZ)' }), icon: <Square size={15} />, onClick: () => c.run('sketch.new', { plane: 'yz' }) },
            ],
          },
          tool('pushpull', t('cao_pushpull', { defaultValue: 'Pousser-tirer' }), <MoveVertical size={18} />, 'large'),
          { id: 'extrude', kind: 'button', size: 'large', label: t('cao_extrude', { defaultValue: 'Extruder' }), icon: <Box size={18} />, onClick: () => c.run('extrude') },
          { id: 'pocket', kind: 'button', size: 'large', label: t('cao_pocket', { defaultValue: 'Poche' }), icon: <SquareMinus size={18} />, onClick: () => c.run('pocket') },
          { id: 'revolve', kind: 'button', size: 'large', label: t('cao_revolve', { defaultValue: 'Révolution' }), icon: <RotateCcw size={18} />, onClick: () => c.run('revolve') },
          { id: 'loft', kind: 'button', size: 'large', label: t('cao_loft', { defaultValue: 'Lissage' }), icon: <Layers size={18} />, onClick: () => c.run('loft') },
        ],
      },
      {
        // Interactive placement tools: two clicks on the ground (corner/corner
        // for the box, centre/radius for the round shapes), live preview + dims.
        id: 'prims', label: t('cao_grp_prims', { defaultValue: 'Primitives' }),
        items: [{
          id: 'prim', kind: 'split', size: 'large',
          label: t('cao_prim_box', { defaultValue: 'Boîte' }), icon: <Box size={18} />,
          active: c.tool.startsWith('prim.'),
          onClick: () => c.setTool('prim.box'),
          splitItems: [
            { id: 'p-box', kind: 'button', label: t('cao_prim_box', { defaultValue: 'Boîte' }), icon: <Box size={15} />, onClick: () => c.setTool('prim.box') },
            { id: 'p-cyl', kind: 'button', label: t('cao_prim_cylinder', { defaultValue: 'Cylindre' }), icon: <Cylinder size={15} />, onClick: () => c.setTool('prim.cylinder') },
            { id: 'p-sph', kind: 'button', label: t('cao_prim_sphere', { defaultValue: 'Sphère' }), icon: <Circle size={15} />, onClick: () => c.setTool('prim.sphere') },
            { id: 'p-cone', kind: 'button', label: t('cao_prim_cone', { defaultValue: 'Cône' }), icon: <Cone size={15} />, onClick: () => c.setTool('prim.cone') },
            { id: 'p-torus', kind: 'button', label: t('cao_prim_torus', { defaultValue: 'Tore' }), icon: <Donut size={15} />, onClick: () => c.setTool('prim.torus') },
          ],
        }],
      },
    ]
  }, [t])

  // Esquisse — contextual tab while the in-place sketch editor is open:
  // constrained drawing tools, constraint buttons (applied to the current
  // selection), driving dimensions, and the finish button. planegcs solves
  // after every action; the DoF chip reports the result.
  const sketchTab = useCallback((c: EditorController): RibbonTab => {
    const tool = toolItem(c)
    const constrain = (id: string, label: string, icon: ReactNode) => ({
      id, kind: 'button' as const, label, icon, onClick: () => c.run('sk.constrain', { kind: id }),
    })
    return {
      id: 'sketch', label: t('sk_tab', { defaultValue: 'Esquisse' }),
      groups: [
        {
          id: 'edit', label: t('grp_edit', { defaultValue: 'Édition' }),
          items: [
            tool('select', t('tool_select', { defaultValue: 'Sélection' }), <MousePointer2 size={18} />, 'large'),
            { id: 'skdel', kind: 'button', label: t('delete', { defaultValue: 'Supprimer' }), icon: <Trash2 size={15} />, disabled: !c.hasSelection, onClick: c.deleteSelection },
          ],
        },
        {
          id: 'draw', label: t('sk_grp_draw', { defaultValue: 'Dessiner' }),
          items: [
            tool('sk.segment', t('sk_segment', { defaultValue: 'Ligne' }), <Minus size={18} />, 'large'),
            tool('sk.rect', t('cao_rect', { defaultValue: 'Rectangle' }), <Square size={18} />, 'large'),
            tool('sk.circle', t('cao_circle', { defaultValue: 'Cercle' }), <Circle size={18} />),
            tool('sk.arc', t('sk_arc', { defaultValue: 'Arc' }), <Spline size={18} />),
            tool('sk.point', t('sk_point', { defaultValue: 'Point' }), <Dot size={18} />),
          ],
        },
        {
          id: 'constrain', label: t('sk_grp_constrain', { defaultValue: 'Contraindre' }),
          items: [
            constrain('coincident', t('sk_coincident', { defaultValue: 'Coïncident' }), <Magnet size={15} />),
            constrain('horizontal', t('sk_horizontal', { defaultValue: 'Horizontal' }), <MoveHorizontal size={15} />),
            constrain('vertical', t('sk_vertical', { defaultValue: 'Vertical' }), <MoveVertical size={15} />),
            constrain('parallel', t('sk_parallel', { defaultValue: 'Parallèle' }), <AlignHorizontalDistributeCenter size={15} />),
            constrain('perpendicular', t('sk_perpendicular', { defaultValue: 'Perpendiculaire' }), <CornerDownRight size={15} />),
            constrain('tangent', t('sk_tangent', { defaultValue: 'Tangent' }), <Spline size={15} />),
            constrain('equal', t('sk_equal', { defaultValue: 'Égal' }), <Equal size={15} />),
            constrain('pointOn', t('sk_point_on', { defaultValue: 'Sur l’objet' }), <LocateFixed size={15} />),
          ],
        },
        {
          id: 'dimension', label: t('sk_grp_dim', { defaultValue: 'Coter' }),
          items: [
            { id: 'dim', kind: 'button', size: 'large', label: t('sk_dim', { defaultValue: 'Cote' }), icon: <Ruler size={18} />, onClick: () => c.run('sk.dim') },
          ],
        },
        {
          id: 'finish', label: t('sk_grp_finish', { defaultValue: 'Fermer' }),
          items: [
            { id: 'finish', kind: 'button', size: 'large', label: t('sk_finish', { defaultValue: 'Terminer l’esquisse' }), icon: <Check size={18} />, onClick: () => c.run('sketch.finish') },
          ],
        },
      ],
    }
  }, [t])

  // Solide — combine (Manifold booleans) / transform (gizmos) / edge modifiers.
  const solidTab = useCallback((c: EditorController): RibbonTab => {
    const tool = toolItem(c)
    return {
      id: 'solid', label: t('tab_solid', { defaultValue: 'Solide' }),
      groups: [
        {
          id: 'combine', label: t('cao_grp_combine', { defaultValue: 'Combiner' }),
          items: [
            { id: 'union', kind: 'button', size: 'large', label: t('cao_union', { defaultValue: 'Union' }), icon: <SquaresUnite size={18} />, onClick: () => c.run('boolean', { operation: 'union' }) },
            { id: 'subtract', kind: 'button', size: 'large', label: t('cao_subtract', { defaultValue: 'Soustraire' }), icon: <SquaresSubtract size={18} />, onClick: () => c.run('boolean', { operation: 'subtract' }) },
            { id: 'intersect', kind: 'button', size: 'large', label: t('cao_intersect', { defaultValue: 'Intersecter' }), icon: <SquaresIntersect size={18} />, onClick: () => c.run('boolean', { operation: 'intersect' }) },
          ],
        },
        {
          id: 'transform', label: t('cao_grp_transform', { defaultValue: 'Transformer' }),
          items: [
            tool('move', t('cao_move', { defaultValue: 'Déplacer' }), <Move3d size={18} />, 'large'),
            tool('rotate', t('cao_rotate', { defaultValue: 'Tourner' }), <Rotate3d size={18} />, 'large'),
          ],
        },
        {
          id: 'repeat', label: t('cao_grp_repeat', { defaultValue: 'Répéter' }),
          items: [
            {
              id: 'mirror', kind: 'split', size: 'large',
              label: t('cao_mirror', { defaultValue: 'Miroir' }), icon: <FlipHorizontal size={18} />,
              onClick: () => c.run('mirror', { axis: 'x' }),
              splitItems: [
                { id: 'mx', kind: 'button', label: t('cao_mirror_x', { defaultValue: 'Miroir plan YZ (axe X)' }), icon: <FlipHorizontal size={15} />, onClick: () => c.run('mirror', { axis: 'x' }) },
                { id: 'mz', kind: 'button', label: t('cao_mirror_z', { defaultValue: 'Miroir plan XY (axe Z)' }), icon: <FlipHorizontal size={15} />, onClick: () => c.run('mirror', { axis: 'z' }) },
              ],
            },
            { id: 'patlin', kind: 'button', size: 'large', label: t('cao_pattern_linear', { defaultValue: 'Rép. linéaire' }), icon: <Grid3x3 size={18} />, onClick: () => c.run('pattern', { mode: 'linear' }) },
            { id: 'patpol', kind: 'button', size: 'large', label: t('cao_pattern_polar', { defaultValue: 'Rép. polaire' }), icon: <RotateCw size={18} />, onClick: () => c.run('pattern', { mode: 'polar' }) },
          ],
        },
        {
          id: 'modify', label: t('cao_grp_modify', { defaultValue: 'Modifier' }),
          items: [
            { id: 'fillet', kind: 'button', size: 'large', label: t('cao_fillet', { defaultValue: 'Congé' }), icon: <Diff size={18} />, onClick: () => c.run('fillet') },
            { id: 'chamfer', kind: 'button', size: 'large', label: t('cao_chamfer', { defaultValue: 'Chanfrein' }), icon: <Slice size={18} />, onClick: () => c.run('chamfer') },
            { id: 'groove', kind: 'button', size: 'large', label: t('cao_groove', { defaultValue: 'Rainure' }), icon: <Disc size={18} />, onClick: () => c.run('groove') },
          ],
        },
      ],
    }
  }, [t])

  // Solide is always there; the Esquisse tab joins (and takes focus, see
  // BuildEditor's auto tab switch) while the sketch editor is open.
  const extraTabs = useCallback((c: EditorController): RibbonTab[] =>
    c.sketchActive ? [sketchTab(c), solidTab(c)] : [solidTab(c)],
  [sketchTab, solidTab])

  return (
    <BuildEditor
      kind="cao3d"
      theme={THEME_CAO3D}
      accent="#c2571a"
      icon={<Box />}
      appLabel={t('cao3d', { defaultValue: 'CAO3D' })}
      newLabel={t('new_cao3d', { defaultValue: 'Nouvelle pièce' })}
      viewportMode="3d"
      gridExtentMm={500}
      gridCellMm={10}
      gridStepMm={5}
      background={0xe9ecf0}
      gridColor={0xc4cad3}
      gradient={[0xfdfdfe, 0xd3d9e0]}
      gridIn3d
      showViewToggle
      navCube
      orthoToggle
      meshExports
      prepare={prepare}
      createEngine={createEngine}
      homeGroups={homeGroups}
      extraTabs={extraTabs}
    />
  )
}
