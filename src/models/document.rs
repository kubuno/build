use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// A Build design document. `kind` selects the sub-application that owns it:
/// `architect` (buildings / urban 2D-3D) or `cao3d` (parametric 3D modeling).
/// The scene JSON lives in a drive file (.kbarch / .kbcao) referenced by
/// `file_id`; `data` is populated from that file when serving a GET (the DB
/// column only carries legacy content until its row is lazily migrated).
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Document {
    pub id:         Uuid,
    pub kind:       String,
    pub title:      String,
    pub data:       serde_json::Value,
    pub unit:       String,
    pub file_id:    Option<Uuid>,
    pub owner_id:   Uuid,
    pub trashed:    bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Lightweight row for listings (omits the potentially large `data` blob).
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct DocumentSummary {
    pub id:         Uuid,
    pub kind:       String,
    pub title:      String,
    pub unit:       String,
    pub trashed:    bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateDocument {
    pub kind:  String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub unit:  Option<String>,
    #[serde(default)]
    pub data:  Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateDocument {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub unit:  Option<String>,
    #[serde(default)]
    pub data:  Option<serde_json::Value>,
}

/// Documents accept exactly these sub-application kinds.
pub fn is_valid_kind(kind: &str) -> bool {
    matches!(kind, "architect" | "cao3d")
}
