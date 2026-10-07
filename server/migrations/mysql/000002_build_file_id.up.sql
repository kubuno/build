-- Document content moves to drive files: the row keeps only metadata + the id
-- of its content file. No partial index on MySQL (unsupported); the plain index
-- serves the same lookups.
ALTER TABLE build.documents ADD COLUMN file_id BINARY(16) NULL;

CREATE INDEX idx_build_documents_file
    ON build.documents (file_id);
