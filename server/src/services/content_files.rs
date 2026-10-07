/// Per-document content files in the drive module (same pattern as office).
///
/// The scene JSON of every Build document lives in a real drive file the user
/// can see, move and rename in Files:
///   architect → Build/Architect/<title>.kbarch
///   cao3d     → Build/CAO3D/<title>.kbcao
/// File format: gzipped `{"version":1,"model":{…scene…}}`. The DB row keeps
/// only metadata + `file_id`; the file name is the source of truth for the
/// title (self-healed on GET).
use anyhow::Result;
use bytes::Bytes;
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde_json::{json, Value};
use std::io::{Read, Write};
use uuid::Uuid;

use crate::{errors::BuildError, state::AppState};

// ── Per-kind constants ────────────────────────────────────────────────────────

pub fn folder_for(kind: &str) -> &'static str {
    if kind == "cao3d" { "Build/CAO3D" } else { "Build/Architect" }
}

pub fn ext_for(kind: &str) -> &'static str {
    if kind == "cao3d" { "kbcao" } else { "kbarch" }
}

pub fn mime_for(kind: &str) -> &'static str {
    if kind == "cao3d" { "application/vnd.kubuno.cao3d+json" } else { "application/vnd.kubuno.architect+json" }
}

fn icon_for(kind: &str) -> &'static str {
    if kind == "cao3d" { "Box" } else { "Building2" }
}

/// Kind derived from a file name extension (for open-by-file imports).
pub fn kind_for_file(name: &str) -> Option<&'static str> {
    let lower = name.to_lowercase();
    if lower.ends_with(".kbcao") { Some("cao3d") } else if lower.ends_with(".kbarch") { Some("architect") } else { None }
}

// ── Envelope ──────────────────────────────────────────────────────────────────

fn content_from(model: &Value) -> Value {
    json!({ "version": 1, "model": model })
}

fn extract_model(content: &Value) -> Value {
    content.get("model").cloned().unwrap_or_else(|| content.clone())
}

// ── File naming ───────────────────────────────────────────────────────────────

pub fn kb_file_name(title: &str, ext: &str) -> String {
    let base = std::path::Path::new(title).file_stem().and_then(|s| s.to_str()).unwrap_or(title);
    let base = if base.trim().is_empty() { "Sans titre" } else { base.trim() };
    format!("{base}.{ext}")
}

pub fn strip_ext(name: &str) -> String {
    crate::files_client::strip_ext(name)
}

// ── Document size ceiling (instance setting) ─────────────────────────────────
// Single enforcement point for both sub-applications: Architect and CAO3D reach
// the drive through the helpers below. Measured on the GZIPPED payload — what is
// actually stored.

fn check_document_size(state: &AppState, gz_len: usize) -> Result<(), BuildError> {
    let max = state.instance().max_document_bytes;
    if gz_len as u64 > max {
        return Err(BuildError::PayloadTooLarge(format!(
            "Document trop volumineux ({} Mo compressés, maximum {} Mo)",
            gz_len as u64 / 1_048_576,
            max / 1_048_576,
        )));
    }
    Ok(())
}

// ── CRUD on the content file ─────────────────────────────────────────────────

/// Create the .kb*** file holding a document's scene; returns its file id.
pub async fn create_build_file(
    state: &AppState, user_id: Uuid, kind: &str, title: &str, model: &Value,
) -> Result<Uuid, BuildError> {
    let folder = state.files_client
        .ensure_folder_path(user_id, folder_for(kind), true, Some(icon_for(kind))).await
        .map_err(BuildError::Internal)?;
    let raw = serde_json::to_vec(&content_from(model))
        .map_err(|e| BuildError::Internal(anyhow::anyhow!(e)))?;
    // A duplicate or an import creates the file with its full model, so the
    // ceiling has to be enforced here too, not only on later saves.
    let gz = gzip(&raw)?;
    check_document_size(state, gz.len())?;
    let file = state.files_client.create_file_with_content(
        user_id, Some(folder.id), &kb_file_name(title, ext_for(kind)),
        mime_for(kind),
        Bytes::from(gz),
        Some(json!({ "module": "build", "subtype": kind })),
        false,
    ).await.map_err(BuildError::Internal)?;
    Ok(file.id)
}

/// Read a document's scene back from its .kb*** file.
pub async fn read_build_model(state: &AppState, user_id: Uuid, file_id: Uuid) -> Result<Value, BuildError> {
    let (_info, raw) = state.files_client.get_file_content(user_id, file_id).await
        .map_err(BuildError::Internal)?;
    let data = gunzip(&raw).unwrap_or_else(|_| raw.to_vec());
    let content = serde_json::from_slice::<Value>(&data)
        .map_err(|e| BuildError::Internal(anyhow::anyhow!("contenu build illisible: {e}")))?;
    Ok(extract_model(&content))
}

/// Overwrite a document's scene in its .kb*** file.
pub async fn write_build_model(state: &AppState, user_id: Uuid, file_id: Uuid, model: &Value) -> Result<(), BuildError> {
    let raw = serde_json::to_vec(&content_from(model))
        .map_err(|e| BuildError::Internal(anyhow::anyhow!(e)))?;
    let gz = gzip(&raw)?;
    check_document_size(state, gz.len())?;
    state.files_client.update_file_content(user_id, file_id, Bytes::from(gz)).await
        .map_err(BuildError::Internal).map(|_| ())
}

/// Rename the .kb*** file after a title change (title = file name).
pub async fn rename_content_file(state: &AppState, owner_id: Uuid, file_id: Uuid, title: &str, ext: &str) -> Result<(), BuildError> {
    state.files_client.rename_file(owner_id, file_id, &kb_file_name(title, ext)).await
        .map_err(|e| BuildError::Internal(anyhow::anyhow!("rename .kb***: {e}")))?;
    Ok(())
}

/// Current name of the content file (best-effort — None on any error).
pub async fn file_name(state: &AppState, owner_id: Uuid, file_id: Uuid) -> Option<String> {
    state.files_client.get_file_meta(owner_id, file_id).await.ok().map(|info| info.name)
}

// ── gzip helpers ──────────────────────────────────────────────────────────────

fn gzip(data: &[u8]) -> Result<Vec<u8>, BuildError> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(data).map_err(|e| BuildError::Internal(anyhow::anyhow!(e)))?;
    enc.finish().map_err(|e| BuildError::Internal(anyhow::anyhow!(e)))
}

/// Tolerant gunzip: plain (non-gzipped) buffers are returned unchanged.
fn gunzip(data: &[u8]) -> Result<Vec<u8>> {
    if data.len() < 2 || data[0] != 0x1f || data[1] != 0x8b {
        return Ok(data.to_vec());
    }
    let mut out = Vec::new();
    GzDecoder::new(data).read_to_end(&mut out)?;
    Ok(out)
}
