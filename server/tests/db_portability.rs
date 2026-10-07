//! Runs build's own migrations and its own document service against a real
//! server of **each** engine, from a single compiled binary — the proof that
//! the engine is a run-time choice, not a build-time one.
//!
//! * SQLite always runs (a temp file, no server).
//! * PostgreSQL runs when `KUBUNO_PG_TEST_URL` points at a throwaway database.
//! * MySQL/MariaDB runs when `KUBUNO_MYSQL_TEST_URL` does.
//!
//! ```sh
//! KUBUNO_PG_TEST_URL=postgres://u:p@localhost:5433/build \
//! KUBUNO_MYSQL_TEST_URL=mysql://u:p@localhost:3307/build \
//!   cargo test --test db_portability
//! ```
//!
//! The same binary contains all three drivers; each engine's suite is one test.

use kubuno_build::services::document_service as svc;
use kubuno_build::SCHEMA;
use uuid::Uuid;

fn base_settings(engine: &str) -> kubuno_db::DbSettings {
    kubuno_db::DbSettings {
        engine: engine.to_string(),
        url: None,
        host: None,
        port: None,
        user: None,
        password: None,
        database: None,
        path: None,
        max_connections: 4,
        min_connections: 0,
        connect_timeout: std::time::Duration::from_secs(10),
        run_migrations: true,
        schema_prefix: None,
    }
}

/// Migrations only run one at a time: the PostgreSQL and MySQL suites may share
/// a server.
static EXCLUSIVE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn migrated_pool(settings: kubuno_db::DbSettings) -> (kubuno_db::DbPool, impl Sized) {
    let guard = EXCLUSIVE.lock().await;
    let pool = kubuno_db::connect(&settings, SCHEMA).await.expect("connect");

    // Exactly the calls `main.rs` makes.
    kubuno_db::migrations!(
        "./migrations/postgres",
        "./migrations/mysql",
        "./migrations/sqlite",
    )
    .run(&pool, SCHEMA)
    .await
    .expect("migrations");

    (pool, guard)
}

/// The whole document DB path the handlers exercise: insert, read back, the
/// list filters, the metadata update, trash/restore (including the MySQL
/// "changed nothing" caveat), permanent delete, import-by-file, and the
/// UserDeleted cleanup — everything but the drive-file orchestration.
async fn full_suite(pool: &kubuno_db::DbPool) {
    let owner = Uuid::new_v4();
    let file_a = Uuid::new_v4();

    // ── insert (explicit unit) and read back ──
    let doc = svc::insert(pool, owner, "architect", "Maison", "cm", file_a)
        .await
        .expect("insert");
    assert_eq!(doc.kind, "architect");
    assert_eq!(doc.title, "Maison");
    assert_eq!(doc.unit, "cm");
    assert_eq!(doc.owner_id, owner);
    assert_eq!(doc.file_id, Some(file_a));
    assert!(!doc.trashed);
    assert_eq!(doc.data, serde_json::json!({}));
    let id_a = doc.id;

    let fetched = svc::get(pool, owner, id_a).await.expect("get").expect("present");
    assert_eq!(fetched.id, id_a);
    assert_eq!(fetched.title, "Maison");

    // A second document of a different kind, imported (unit defaults to "mm").
    let file_b = Uuid::new_v4();
    let imported = svc::insert_imported(pool, owner, "cao3d", "Piece", file_b)
        .await
        .expect("insert_imported");
    assert_eq!(imported.unit, "mm", "the column default has to apply on every engine");
    let id_b = imported.id;

    // ── list: filters by trashed and by kind ──
    let active = svc::list(pool, owner, false, None).await.expect("list");
    assert_eq!(active.len(), 2);
    // Ordered by updated_at DESC — the second insert is not older than the first.
    let only_cao = svc::list(pool, owner, false, Some("cao3d")).await.expect("list kind");
    assert_eq!(only_cao.len(), 1);
    assert_eq!(only_cao[0].id, id_b);
    let none_trashed = svc::list(pool, owner, true, None).await.expect("list trashed");
    assert!(none_trashed.is_empty());

    // ── metadata update (COALESCE keeps the untouched column) ──
    let file_a2 = Uuid::new_v4();
    svc::update_meta(pool, owner, id_a, Some("Villa"), None, file_a2)
        .await
        .expect("update_meta");
    let updated = svc::get(pool, owner, id_a).await.expect("get").expect("present");
    assert_eq!(updated.title, "Villa");
    assert_eq!(updated.unit, "cm", "None title/unit must leave the column unchanged");
    assert_eq!(updated.file_id, Some(file_a2));

    // ── the self-heal title update ──
    svc::set_title(pool, id_a, "Chalet").await.expect("set_title");
    assert_eq!(svc::get(pool, owner, id_a).await.unwrap().unwrap().title, "Chalet");

    // ── file_id lookup ──
    assert_eq!(
        svc::file_id_of(pool, owner, id_a).await.expect("file_id_of"),
        Some(Some(file_a2))
    );
    assert!(
        svc::file_id_of(pool, owner, Uuid::new_v4()).await.expect("file_id_of").is_none(),
        "a missing document yields the outer None"
    );

    // ── trash / restore, and the MySQL "changed nothing" caveat ──
    assert!(svc::set_trashed(pool, owner, id_a, true).await.expect("trash"));
    assert!(svc::get(pool, owner, id_a).await.unwrap().unwrap().trashed);
    // Trashing an already-trashed row: MySQL's rows_affected is 0 here, yet the
    // row exists, so the helper must still report success from its SELECT.
    assert!(
        svc::set_trashed(pool, owner, id_a, true).await.expect("re-trash"),
        "an unchanged UPDATE must not read as a missing row"
    );
    // A genuinely missing document reports false.
    assert!(!svc::set_trashed(pool, owner, Uuid::new_v4(), true).await.expect("trash missing"));
    assert!(svc::set_trashed(pool, owner, id_a, false).await.expect("restore"));
    assert!(!svc::get(pool, owner, id_a).await.unwrap().unwrap().trashed);

    // ── find the active document behind a drive file ──
    assert_eq!(
        svc::find_active_by_file(pool, owner, file_b).await.expect("find_active"),
        Some(id_b)
    );
    // Trashed rows are excluded.
    svc::set_trashed(pool, owner, id_b, true).await.expect("trash b");
    assert!(svc::find_active_by_file(pool, owner, file_b).await.expect("find_active").is_none());

    // ── permanent delete ──
    svc::delete(pool, owner, id_b).await.expect("delete");
    assert!(svc::get(pool, owner, id_b).await.expect("get").is_none());

    // ── two owners must not see each other's documents ──
    let other = Uuid::new_v4();
    let _ = svc::insert(pool, other, "architect", "Autre", "mm", Uuid::new_v4()).await.expect("other insert");
    assert_eq!(svc::list(pool, owner, false, None).await.unwrap().len(), 1, "only id_a remains for owner");
    assert!(svc::get(pool, owner, id_a).await.unwrap().is_some());
    assert!(svc::get(pool, other, id_a).await.unwrap().is_none(), "owner scoping holds");

    // ── the UserDeleted cleanup (the real bus handler) ──
    kubuno_build::events::handle(
        kubuno_build::events::BuildEvent::UserDeleted { user_id: owner },
        pool,
    )
    .await;
    assert!(svc::list(pool, owner, false, None).await.unwrap().is_empty());
    assert!(svc::list(pool, owner, true, None).await.unwrap().is_empty());
    // The other owner's document survives.
    assert_eq!(svc::list(pool, other, false, None).await.unwrap().len(), 1);
    svc::delete_all_for_owner(pool, other).await.expect("cleanup other");
}

#[tokio::test]
async fn sqlite_from_the_one_binary() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut s = base_settings("sqlite");
    s.path = Some(dir.path().to_string_lossy().into_owned());
    let (pool, _keep) = migrated_pool(s).await;
    full_suite(&pool).await;
}

#[tokio::test]
async fn postgres_from_the_one_binary() {
    let Ok(url) = std::env::var("KUBUNO_PG_TEST_URL") else {
        eprintln!("skipping: KUBUNO_PG_TEST_URL not set");
        return;
    };
    let mut s = base_settings("postgres");
    s.url = Some(url);
    let (pool, _keep) = migrated_pool(s).await;
    full_suite(&pool).await;
}

#[tokio::test]
async fn mysql_from_the_one_binary() {
    let Ok(url) = std::env::var("KUBUNO_MYSQL_TEST_URL") else {
        eprintln!("skipping: KUBUNO_MYSQL_TEST_URL not set");
        return;
    };
    let mut s = base_settings("mysql");
    s.url = Some(url);
    let (pool, _keep) = migrated_pool(s).await;
    full_suite(&pool).await;
}
