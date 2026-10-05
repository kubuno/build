DROP INDEX IF EXISTS build.idx_build_documents_file;
ALTER TABLE build.documents DROP COLUMN IF EXISTS file_id;
