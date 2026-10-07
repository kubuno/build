pub mod config;
pub mod errors;
pub mod events;
pub mod handlers;
pub mod middleware;
pub mod models;
pub mod router;
pub mod services;
pub mod state;

/// The module's database namespace: a PostgreSQL schema, a MySQL database, or
/// the ATTACHed SQLite file. Declared once and passed to every kubuno-db call.
pub const SCHEMA: &str = "build";

/// FilesClient (IPC to the drive module) — same alias convention as office.
pub use kubuno_drive::client as files_client;
