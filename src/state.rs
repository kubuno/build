use crate::{config::Settings, files_client::FilesClient};
use kubuno_db::DbPool;
use reqwest::Client;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub db:           DbPool,
    pub settings:     Arc<Settings>,
    pub http:         Client,
    /// IPC client to the drive module — document content lives in .kb*** files.
    pub files_client: Arc<FilesClient>,
    /// Instance settings from the admin console, refreshed in the background so
    /// an edit takes effect without restarting the module. A `std::sync` lock
    /// (not a `tokio` one) because callers read a snapshot synchronously; the
    /// critical section only clones a handful of fields.
    pub instance:     Arc<std::sync::RwLock<crate::config::instance::InstanceConfig>>,
}

impl AppState {
    /// A snapshot of the current instance settings. Falls back to the compiled
    /// defaults if the lock was poisoned by a panicking writer — a lost value
    /// must never change a default silently.
    pub fn instance(&self) -> crate::config::instance::InstanceConfig {
        self.instance.read().map(|c| c.clone()).unwrap_or_default()
    }
}
