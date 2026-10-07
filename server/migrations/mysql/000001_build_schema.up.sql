-- MySQL / MariaDB. The `build` database is created by kubuno-db's
-- `ensure_schema` before the migrator runs, so there is no CREATE here.
--
-- Differences from the PostgreSQL file, and why:
--   * UUID      -> BINARY(16): what sqlx encodes a `uuid::Uuid` as on MySQL.
--   * No DEFAULT on `id`: MySQL has no gen_random_uuid(), and the process has
--     to supply the key anyway since MySQL has no RETURNING.
--   * TEXT columns that an index touches become VARCHAR: MySQL cannot index a
--     TEXT without a prefix length. `kind` is part of the owner index, so it is
--     VARCHAR; `title`/`unit` are VARCHAR too so they can carry a DEFAULT.
--   * JSONB      -> JSON.
--   * TIMESTAMPTZ -> DATETIME(6): no time zone in the column; every value
--     written is UTC (the session runs at +00:00). `updated_at` is bumped
--     explicitly by the module, so there is no ON UPDATE clause.
CREATE TABLE build.documents (
    id         BINARY(16)   NOT NULL PRIMARY KEY,
    kind       VARCHAR(32)  NOT NULL,
    title      VARCHAR(255) NOT NULL DEFAULT 'Sans titre',
    unit       VARCHAR(16)  NOT NULL DEFAULT 'mm',
    data       JSON         NOT NULL,
    owner_id   BINARY(16)   NOT NULL,
    trashed    BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT chk_build_documents_kind CHECK (kind IN ('architect', 'cao3d'))
);

CREATE INDEX idx_build_documents_owner
    ON build.documents (owner_id, kind, trashed, updated_at);
