-- Document content moves to drive files (.kbarch / .kbcao): the row keeps only
-- metadata + the id of its content file. `data` stays for legacy rows and is
-- emptied once a row is lazily migrated to a file.
ALTER TABLE build.documents ADD COLUMN IF NOT EXISTS file_id UUID;

CREATE INDEX IF NOT EXISTS idx_build_documents_file
    ON build.documents (file_id) WHERE file_id IS NOT NULL;
