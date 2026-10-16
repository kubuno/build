use axum::{
    extract::DefaultBodyLimit,
    middleware,
    routing::{delete, get, post},
    Router,
};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use crate::{
    handlers::{documents, health},
    middleware::{require_auth, require_ipc_secret},
    state::AppState,
};

pub fn build(state: AppState) -> Router {
    // Authenticated document CRUD (Architect + CAO3D share the same store).
    let authed = Router::new()
        .route("/config",              get(config_handler))
        .route("/documents",           get(documents::list).post(documents::create))
        .route("/documents/open-by-file", post(documents::open_by_file))
        .route("/documents/:id",       get(documents::get).patch(documents::update))
        .route("/documents/:id/trash",     post(documents::trash))
        .route("/documents/:id/restore",   post(documents::restore))
        .route("/documents/:id/delete",    delete(documents::delete_permanent))
        .route("/documents/:id/duplicate", post(documents::duplicate))
        .layer(middleware::from_fn_with_state(state.clone(), require_auth))
        .with_state(state.clone());

    let system = Router::new()
        .route("/health", get(health::health))
        .with_state(state.clone());

    let ipc = Router::new()
        .route("/ipc/events", post(ipc_events))
        .layer(middleware::from_fn_with_state(state.clone(), require_ipc_secret))
        .with_state(state.clone());

    Router::new()
        .merge(system)
        .merge(ipc)
        .nest("/", authed)
        // Scenes can be large (3D geometry) - allow generous request bodies.
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
}

async fn config_handler(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Extension(_user): axum::extract::Extension<crate::middleware::BuildUser>,
) -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "server":  { "port": state.settings.server.port },
    }))
}

async fn ipc_events(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::Json(body): axum::Json<serde_json::Value>,
) -> axum::Json<serde_json::Value> {
    if let Ok(event) = serde_json::from_value::<crate::events::BuildEvent>(body) {
        crate::events::handle(event, &state.db).await;
    }
    axum::Json(serde_json::json!({ "ok": true }))
}
