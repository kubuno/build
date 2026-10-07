use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum BuildError {
    #[error("Non authentifié")]
    Unauthorized,

    #[error("Accès refusé")]
    Forbidden,

    #[error("Ressource introuvable: {0}")]
    NotFound(String),

    #[error("Données invalides: {0}")]
    Validation(String),

    /// The payload exceeds an instance ceiling set by the administrator.
    #[error("{0}")]
    PayloadTooLarge(String),

    #[error("Erreur base de données")]
    Database(#[from] sqlx::Error),

    #[error("Erreur interne")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for BuildError {
    fn into_response(self) -> Response {
        let (status, code, message) = match &self {
            BuildError::Unauthorized  => (StatusCode::UNAUTHORIZED,         "UNAUTHORIZED", self.to_string()),
            BuildError::Forbidden     => (StatusCode::FORBIDDEN,            "FORBIDDEN",    self.to_string()),
            BuildError::NotFound(_)   => (StatusCode::NOT_FOUND,            "NOT_FOUND",    self.to_string()),
            BuildError::Validation(_) => (StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION",   self.to_string()),
            BuildError::PayloadTooLarge(_) => (StatusCode::PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE", self.to_string()),
            BuildError::Database(e) => {
                tracing::error!(error = %e, "Erreur base de données");
                (StatusCode::INTERNAL_SERVER_ERROR, "DATABASE_ERROR", "Erreur interne".to_string())
            }
            BuildError::Internal(e) => {
                tracing::error!(error = %e, "Erreur interne");
                (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "Erreur interne".to_string())
            }
        };
        (status, Json(json!({ "error": { "code": code, "message": message } }))).into_response()
    }
}
