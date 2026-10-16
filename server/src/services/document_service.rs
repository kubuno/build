//! The document table's DB operations, isolated from the drive-file
//! orchestration in the handlers so they can run against any of the three
//! engines from one binary (same split as keestore's `vault_service`).
//!
//! Every statement is written in PostgreSQL's `$n` dialect; kubuno-db rewrites
//! it to `?` for the engines that want that, so placeholders may never appear
//! out of order or be reused. Two portability points recur here:
//!
//! * **The key is generated in Rust** ([`kubuno_db::new_id`]) and bound: MySQL
//!   and SQLite have no server-side UUID default and MySQL has no `RETURNING`,
//!   so a fresh row is read back with a re-select by its known id.
//! * **Timestamps are bound from the process** (`Utc::now()`), never `now()`:
//!   the three engines spell it differently and SQLite has no time zone.

use chrono::Utc;
use kubuno_db::{params, DbPool};
use uuid::Uuid;

use crate::models::{Document, DocumentSummary};

/// Column list of `build.documents`. A macro rather than a `const` so it can be
/// pasted into `concat!`: every statement below is then a single compile-time
/// string literal, never SQL assembled at run time.
macro_rules! cols {
    () => {
        "id, kind, title, data, unit, file_id, owner_id, trashed, created_at, updated_at"
    };
}

/// One document by id, scoped to its owner. Also used to read back a freshly
/// inserted row.
const SELECT_ONE: &str =
    concat!("SELECT ", cols!(), " FROM build.documents WHERE id = $1 AND owner_id = $2");

/// Insert a new document (explicit unit). `data` is bound empty: the scene
/// lives in the .kb*** file, the column only ever holds `{}`.
const INSERT_DOCUMENT: &str = "INSERT INTO build.documents \
     (id, kind, title, unit, file_id, owner_id, data) \
     VALUES ($1, $2, $3, $4, $5, $6, $7)";

/// Insert a document imported from an existing drive file (unit left to the
/// column default).
const INSERT_IMPORTED: &str = "INSERT INTO build.documents \
     (id, kind, title, file_id, owner_id, data) \
     VALUES ($1, $2, $3, $4, $5, $6)";

/// The empty JSON the `data` column always carries (content is in the file).
fn empty_data() -> serde_json::Value {
    serde_json::json!({})
}

/// Fetch one document row, without hydrating it from its content file.
pub async fn get(db: &DbPool, owner_id: Uuid, id: Uuid) -> Result<Option<Document>, sqlx::Error> {
    db.fetch_optional_as::<Document>(SELECT_ONE, params![id, owner_id]).await
}

/// List the owner's documents (summaries only - no scene blob). The optional
/// `kind` is bound twice ($3, $4): a placeholder cannot be reused, and a typed
/// NULL parameter carries text without PostgreSQL's `$3::text` cast.
pub async fn list(
    db: &DbPool,
    owner_id: Uuid,
    trashed: bool,
    kind: Option<&str>,
) -> Result<Vec<DocumentSummary>, sqlx::Error> {
    db.fetch_all_as::<DocumentSummary>(
        "SELECT id, kind, title, unit, trashed, created_at, updated_at
           FROM build.documents
          WHERE owner_id = $1 AND trashed = $2
            AND ($3 IS NULL OR kind = $4)
          ORDER BY updated_at DESC",
        params![owner_id, trashed, kind, kind],
    )
    .await
}

/// Insert a document with an explicit unit; returns the stored row.
pub async fn insert(
    db: &DbPool,
    owner_id: Uuid,
    kind: &str,
    title: &str,
    unit: &str,
    file_id: Uuid,
) -> Result<Document, sqlx::Error> {
    let id = kubuno_db::new_id();
    db.execute(
        INSERT_DOCUMENT,
        params![id, kind, title, unit, file_id, owner_id, empty_data()],
    )
    .await?;
    db.fetch_one_as::<Document>(SELECT_ONE, params![id, owner_id]).await
}

/// Insert a document imported from a drive file (unit defaulted); returns the
/// stored row.
pub async fn insert_imported(
    db: &DbPool,
    owner_id: Uuid,
    kind: &str,
    title: &str,
    file_id: Uuid,
) -> Result<Document, sqlx::Error> {
    let id = kubuno_db::new_id();
    db.execute(
        INSERT_IMPORTED,
        params![id, kind, title, file_id, owner_id, empty_data()],
    )
    .await?;
    db.fetch_one_as::<Document>(SELECT_ONE, params![id, owner_id]).await
}

/// Apply a partial metadata update (title/unit are `COALESCE`d) and re-empty
/// the `data` column. `updated_at` is bound, not `now()`.
pub async fn update_meta(
    db: &DbPool,
    owner_id: Uuid,
    id: Uuid,
    title: Option<&str>,
    unit: Option<&str>,
    file_id: Uuid,
) -> Result<(), sqlx::Error> {
    db.execute(
        "UPDATE build.documents
            SET title      = COALESCE($1, title),
                unit       = COALESCE($2, unit),
                file_id    = $3,
                data       = $4,
                updated_at = $5
          WHERE id = $6 AND owner_id = $7",
        params![title, unit, file_id, empty_data(), Utc::now(), id, owner_id],
    )
    .await?;
    Ok(())
}

/// Self-heal the stored title from the content file's name.
pub async fn set_title(db: &DbPool, id: Uuid, title: &str) -> Result<(), sqlx::Error> {
    db.execute(
        "UPDATE build.documents SET title = $1 WHERE id = $2",
        params![title, id],
    )
    .await?;
    Ok(())
}

/// Migrate a legacy row (content still in the DB column) to a content file id.
pub async fn attach_file(db: &DbPool, id: Uuid, file_id: Uuid) -> Result<(), sqlx::Error> {
    db.execute(
        "UPDATE build.documents SET file_id = $1, data = $2 WHERE id = $3",
        params![file_id, empty_data(), id],
    )
    .await?;
    Ok(())
}

/// Set (or clear) the trashed flag; returns `false` when no such document
/// exists for the owner.
///
/// Existence is checked with a SELECT rather than by reading `rows_affected`:
/// MySQL reports 0 affected rows for an UPDATE that changed nothing (trashing
/// an already-trashed document), which a caller cannot tell from a missing row.
pub async fn set_trashed(
    db: &DbPool,
    owner_id: Uuid,
    id: Uuid,
    trashed: bool,
) -> Result<bool, sqlx::Error> {
    let exists = db
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM build.documents WHERE id = $1 AND owner_id = $2",
            params![id, owner_id],
        )
        .await?;
    if exists.is_none() {
        return Ok(false);
    }
    db.execute(
        "UPDATE build.documents SET trashed = $1, updated_at = $2 WHERE id = $3 AND owner_id = $4",
        params![trashed, Utc::now(), id, owner_id],
    )
    .await?;
    Ok(true)
}

/// The content file id of a document, if the document exists. The outer
/// `Option` answers "does the row exist?", the inner one "is `file_id` set?".
pub async fn file_id_of(
    db: &DbPool,
    owner_id: Uuid,
    id: Uuid,
) -> Result<Option<Option<Uuid>>, sqlx::Error> {
    db.fetch_optional_scalar::<Option<Uuid>>(
        "SELECT file_id FROM build.documents WHERE id = $1 AND owner_id = $2",
        params![id, owner_id],
    )
    .await
}

/// Permanently remove a document row (the content file is cleaned by the
/// caller).
pub async fn delete(db: &DbPool, owner_id: Uuid, id: Uuid) -> Result<(), sqlx::Error> {
    db.execute(
        "DELETE FROM build.documents WHERE id = $1 AND owner_id = $2",
        params![id, owner_id],
    )
    .await?;
    Ok(())
}

/// The id of the active (non-trashed) document behind a drive file, if any.
/// `trashed` is bound rather than written as the `FALSE` keyword, which is not
/// portable to every engine version.
pub async fn find_active_by_file(
    db: &DbPool,
    owner_id: Uuid,
    file_id: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    db.fetch_optional_scalar::<Uuid>(
        "SELECT id FROM build.documents WHERE file_id = $1 AND owner_id = $2 AND trashed = $3",
        params![file_id, owner_id, false],
    )
    .await
}

/// Remove every document of an owner (the `UserDeleted` bus event).
pub async fn delete_all_for_owner(db: &DbPool, owner_id: Uuid) -> Result<(), sqlx::Error> {
    db.execute(
        "DELETE FROM build.documents WHERE owner_id = $1",
        params![owner_id],
    )
    .await?;
    Ok(())
}
