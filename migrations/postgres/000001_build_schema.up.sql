-- Build module: design documents shared by the Architect and CAO3D sub-apps.
CREATE TABLE IF NOT EXISTS build.documents (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind       TEXT NOT NULL CHECK (kind IN ('architect', 'cao3d')),
    title      TEXT NOT NULL DEFAULT 'Sans titre',
    unit       TEXT NOT NULL DEFAULT 'mm',
    data       JSONB NOT NULL DEFAULT '{}'::jsonb,
    owner_id   UUID NOT NULL,
    trashed    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_build_documents_owner
    ON build.documents (owner_id, kind, trashed, updated_at DESC);
