use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    errors::BuildError,
    middleware::BuildUser,
    models::{is_valid_kind, CreateDocument, Document, DocumentSummary, UpdateDocument},
    services::{content_files as cf, document_service as svc},
    state::AppState,
};

#[derive(Debug, Deserialize)]
pub struct ListParams {
    /// Filter by sub-application: `architect` | `cao3d`.
    pub kind:    Option<String>,
    /// When true, list trashed documents instead of active ones.
    #[serde(default)]
    pub trashed: bool,
}

/// List the caller's documents (summaries only - no scene blob).
pub async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<BuildUser>,
    Query(params): Query<ListParams>,
) -> Result<Json<Vec<DocumentSummary>>, BuildError> {
    let rows = svc::list(&state.db, user.id, params.trashed, params.kind.as_deref()).await?;
    Ok(Json(rows))
}

/// Load a document and hydrate it from its .kb*** content file: the scene JSON
/// is read from the file and the title self-heals from the file name (the file
/// is the source of truth - it may have been renamed in Files). Legacy rows
/// whose content still lives in the `data` column are migrated to a file on
/// first read.
async fn fetch_document(state: &AppState, owner_id: Uuid, id: Uuid) -> Result<Document, BuildError> {
    let mut doc = svc::get(&state.db, owner_id, id)
        .await?
        .ok_or_else(|| BuildError::NotFound("document".into()))?;

    match doc.file_id {
        Some(fid) => {
            doc.data = cf::read_build_model(state, owner_id, fid).await.unwrap_or_else(|e| {
                tracing::error!(error = %e, document = %id, "lecture du fichier de contenu échouée");
                serde_json::json!({})
            });
            if let Some(fname) = cf::file_name(state, owner_id, fid).await {
                let stem = cf::strip_ext(&fname);
                if !stem.is_empty() && stem != doc.title {
                    svc::set_title(&state.db, id, &stem).await?;
                    doc.title = stem;
                }
            }
        }
        None => {
            // Legacy row: content still in the DB column → move it to a file.
            let fid = cf::create_build_file(state, owner_id, &doc.kind, &doc.title, &doc.data).await?;
            svc::attach_file(&state.db, id, fid).await?;
            doc.file_id = Some(fid);
        }
    }
    Ok(doc)
}

/// Create an empty (or seeded) document: the scene goes to a new .kb*** file
/// in drive, the row only keeps metadata + the file id.
pub async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<BuildUser>,
    Json(body): Json<CreateDocument>,
) -> Result<Json<Document>, BuildError> {
    if !is_valid_kind(&body.kind) {
        return Err(BuildError::Validation(format!("type inconnu: {}", body.kind)));
    }
    let title = body.title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| "Sans titre".to_string());
    let unit = body.unit.unwrap_or_else(|| "mm".to_string());
    let data = body.data.unwrap_or_else(|| serde_json::json!({}));

    let file_id = cf::create_build_file(&state, user.id, &body.kind, &title, &data).await?;

    let mut doc = svc::insert(&state.db, user.id, &body.kind, &title, &unit, file_id).await?;
    doc.data = data;
    Ok(Json(doc))
}

/// Fetch one full document (scene read from its content file).
pub async fn get(
    State(state): State<AppState>,
    Extension(user): Extension<BuildUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Document>, BuildError> {
    Ok(Json(fetch_document(&state, user.id, id).await?))
}

/// Partial update. Scene changes are written to the content file; a title
/// change also renames the .kb*** (title = file name).
pub async fn update(
    State(state): State<AppState>,
    Extension(user): Extension<BuildUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateDocument>,
) -> Result<Json<Document>, BuildError> {
    let existing = svc::get(&state.db, user.id, id)
        .await?
        .ok_or_else(|| BuildError::NotFound("document".into()))?;

    // Scene → content file (created on the fly for un-migrated legacy rows).
    let file_id = match existing.file_id {
        Some(fid) => {
            if let Some(data) = &body.data {
                cf::write_build_model(&state, user.id, fid, data).await?;
            }
            fid
        }
        None => {
            let data = body.data.clone().unwrap_or_else(|| existing.data.clone());
            cf::create_build_file(&state, user.id, &existing.kind, &existing.title, &data).await?
        }
    };

    svc::update_meta(&state.db, user.id, id, body.title.as_deref(), body.unit.as_deref(), file_id).await?;

    // Title changed → rename the content file. Best-effort: a rename failure
    // must not fail the save (next GET self-heals the title from the file).
    if let Some(title) = body.title.as_deref() {
        if !title.trim().is_empty() {
            if let Err(e) = cf::rename_content_file(&state, user.id, file_id, title, cf::ext_for(&existing.kind)).await {
                tracing::warn!(error = %e, document = %id, "rename du fichier de contenu échoué");
            }
        }
    }

    Ok(Json(fetch_document(&state, user.id, id).await?))
}

pub async fn trash(
    State(state): State<AppState>,
    Extension(user): Extension<BuildUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, BuildError> {
    if !svc::set_trashed(&state.db, user.id, id, true).await? {
        return Err(BuildError::NotFound("document".into()));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn restore(
    State(state): State<AppState>,
    Extension(user): Extension<BuildUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, BuildError> {
    if !svc::set_trashed(&state.db, user.id, id, false).await? {
        return Err(BuildError::NotFound("document".into()));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn delete_permanent(
    State(state): State<AppState>,
    Extension(user): Extension<BuildUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, BuildError> {
    let file_id = svc::file_id_of(&state.db, user.id, id)
        .await?
        .ok_or_else(|| BuildError::NotFound("document".into()))?;

    svc::delete(&state.db, user.id, id).await?;

    // Clean the orphaned content file (best-effort - the row is already gone).
    if let Some(fid) = file_id {
        if let Err(e) = state.files_client.delete_file(user.id, fid).await {
            tracing::warn!(error = %e, document = %id, "suppression du fichier de contenu échouée");
        }
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Duplicate a document: the scene is read from the source file and written
/// into a brand-new .kb*** ("(copie)" suffix), then a new row is inserted.
pub async fn duplicate(
    State(state): State<AppState>,
    Extension(user): Extension<BuildUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Document>, BuildError> {
    let source = fetch_document(&state, user.id, id).await?;
    let title = format!("{} (copie)", source.title);
    let file_id = cf::create_build_file(&state, user.id, &source.kind, &title, &source.data).await?;

    let mut doc = svc::insert(&state.db, user.id, &source.kind, &title, &source.unit, file_id).await?;
    doc.data = source.data;
    Ok(Json(doc))
}

#[derive(Debug, Deserialize)]
pub struct OpenByFileDto {
    pub file_id: Uuid,
}

/// Resolve (or import) the document behind a drive file - used by the Files
/// double-click. A .kbarch/.kbcao copied or uploaded into drive has no row
/// yet: one is created on the fly so the file opens like any document.
pub async fn open_by_file(
    State(state): State<AppState>,
    Extension(user): Extension<BuildUser>,
    Json(dto): Json<OpenByFileDto>,
) -> Result<Json<Document>, BuildError> {
    if let Some(id) = svc::find_active_by_file(&state.db, user.id, dto.file_id).await? {
        return Ok(Json(fetch_document(&state, user.id, id).await?));
    }

    // Import: derive the kind from the file name and link a fresh row.
    let fname = cf::file_name(&state, user.id, dto.file_id).await
        .ok_or_else(|| BuildError::NotFound("fichier".into()))?;
    let kind = cf::kind_for_file(&fname)
        .ok_or_else(|| BuildError::Validation(format!("extension non gérée: {fname}")))?;
    let title = cf::strip_ext(&fname);

    let mut doc = svc::insert_imported(&state.db, user.id, kind, &title, dto.file_id).await?;
    doc.data = cf::read_build_model(&state, user.id, dto.file_id).await.unwrap_or_else(|_| serde_json::json!({}));
    Ok(Json(doc))
}
