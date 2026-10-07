DROP INDEX idx_build_documents_file ON build.documents;
ALTER TABLE build.documents DROP COLUMN file_id;
