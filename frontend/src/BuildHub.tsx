import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { DraftingCompass, Building2, Box, ArrowRight } from 'lucide-react'
import { buildApi } from './api'
import type { BuildDocumentSummary, DocKind } from './types'

// Build suite home (Office-style): one card per sub-application that navigates
// to its landing page (start page + recents), plus the module-wide recents.
export default function BuildHub() {
  const navigate = useNavigate()
  const { t, i18n } = useTranslation('build')
  const [docs, setDocs] = useState<BuildDocumentSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    buildApi.list().then(d => { if (!cancelled) { setDocs(d); setLoading(false) } }).catch(() => setLoading(false))
    return () => { cancelled = true }
  }, [])

  const cards: { kind: DocKind; Icon: typeof Building2; title: string; desc: string; accent: string }[] = [
    { kind: 'architect', Icon: Building2, title: t('architect', { defaultValue: 'Architect' }), desc: t('architect_desc', { defaultValue: '' }), accent: '#1f6f8b' },
    { kind: 'cao3d', Icon: Box, title: t('cao3d', { defaultValue: 'CAO3D' }), desc: t('cao3d_desc', { defaultValue: '' }), accent: '#c2571a' },
  ]

  return (
    <div className="w-full h-full overflow-auto bg-surface-1 text-text-primary">
      <div className="max-w-5xl mx-auto px-8 py-10">
        <div className="flex items-center gap-3 mb-1">
          <DraftingCompass size={26} className="text-text-secondary" />
          <h1 className="text-2xl font-semibold">{t('build', { defaultValue: 'Build' })}</h1>
        </div>
        <p className="text-text-secondary mb-8">{t('hub_subtitle', { defaultValue: '' })}</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mb-10">
          {cards.map(c => (
            <button key={c.kind} onClick={() => navigate(`/build/${c.kind}`)}
              className="text-left rounded-2xl border border-border p-6 hover:shadow-lg transition-shadow bg-surface-2">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4" style={{ background: `${c.accent}22`, color: c.accent }}>
                <c.Icon size={26} />
              </div>
              <div className="text-lg font-semibold mb-1">{c.title}</div>
              <div className="text-xs text-text-secondary mb-4">{c.desc}</div>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: c.accent }}>
                {t('open_app', { defaultValue: 'Ouvrir' })} <ArrowRight size={15} />
              </span>
            </button>
          ))}
        </div>

        <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">{t('recent', { defaultValue: 'Récents' })}</h2>
        {loading ? (
          <div className="text-text-secondary text-xs">{t('loading', { defaultValue: 'Chargement…' })}</div>
        ) : docs.length === 0 ? (
          <div className="text-text-secondary text-xs">{t('no_docs', { defaultValue: 'Rien pour l’instant.' })}</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {docs.map(d => (
              <button key={d.id} onClick={() => navigate(`/build/${d.kind}/${d.id}`)}
                className="text-left rounded-xl border border-border p-4 hover:bg-surface-2 transition-colors">
                <div className="flex items-center gap-2 mb-1">
                  {d.kind === 'architect' ? <Building2 size={16} className="text-text-secondary" /> : <Box size={16} className="text-text-secondary" />}
                  <span className="font-medium truncate">{d.title}</span>
                </div>
                <div className="text-xs text-text-secondary">{d.kind === 'architect' ? t('architect', { defaultValue: 'Architect' }) : t('cao3d', { defaultValue: 'CAO3D' })} · {new Date(d.updated_at).toLocaleDateString(i18n.language || 'fr-FR')}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
