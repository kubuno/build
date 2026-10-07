-- SQLite. `build` is an ATTACHed database file, attached on every pooled
-- connection by kubuno-db, so the qualified names below resolve as they do on
-- the other two engines.
--
-- Differences from the PostgreSQL file, and why:
--   * UUID -> BLOB: what sqlx encodes a `uuid::Uuid` as on SQLite.
--   * No DEFAULT on `id`: SQLite has no UUID generator; the process supplies it.
--   * JSONB -> TEXT (a JSON string sqlx decodes into serde_json::Value).
--   * TIMESTAMPTZ -> TEXT, in the `%F %T%.f` shape sqlx decodes into
--     DateTime<Utc>. Every value written is UTC. `updated_at` is bumped
--     explicitly by the module, so no trigger is needed.
CREATE TABLE build.documents (
    id         BLOB    NOT NULL PRIMARY KEY,
    kind       TEXT    NOT NULL CHECK (kind IN ('architect', 'cao3d')),
    title      TEXT    NOT NULL DEFAULT 'Sans titre',
    unit       TEXT    NOT NULL DEFAULT 'mm',
    data       TEXT    NOT NULL DEFAULT '{}',
    owner_id   BLOB    NOT NULL,
    trashed    BOOLEAN NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);

CREATE INDEX build.idx_build_documents_owner
    ON documents (owner_id, kind, trashed, updated_at DESC);
