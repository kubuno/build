use serde::Deserialize;
use uuid::Uuid;

/// Events consumed from the core bus (declared in module.toml `[events]`).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum BuildEvent {
    UserDeleted { user_id: Uuid },
}

pub async fn handle(event: BuildEvent, db: &kubuno_db::DbPool) {
    match event {
        BuildEvent::UserDeleted { user_id } => {
            let _ = crate::services::document_service::delete_all_for_owner(db, user_id).await;
            tracing::info!(%user_id, "Build: documents supprimés pour l'utilisateur");
        }
    }
}
