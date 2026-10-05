-- Document content moves to drive files: the row keeps only metadata + the id
-- of its content file. SQLite supports the partial index, like PostgreSQL.
ALTER TABLE build.documents ADD COLUMN file_id BLOB;

CREATE INDEX build.idx_build_documents_file
    ON documents (file_id) WHERE file_id IS NOT NULL;
