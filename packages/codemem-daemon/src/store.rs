use crate::model::{
    CloneFingerprint, FileDocument, ImportEdge, PublicApiSymbol, SessionSnapshot, StoreStats,
    TypeShapeRecord,
};
#[cfg(test)]
use crate::model::IndexJobRecord;
use crate::protocol::FleetCorrelation;
use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

const CURRENT_SCHEMA_VERSION: i64 = 1;

pub struct Store {
    db_path: PathBuf,
}

impl Store {
    pub fn open(state_dir: &Path) -> Result<Self> {
        fs::create_dir_all(state_dir).with_context(|| {
            format!(
                "failed to create codemem state directory: {}",
                state_dir.display()
            )
        })?;
        let db_path = state_dir.join("codemem.sqlite3");
        let store = Self { db_path };
        store.migrate_schema()?;
        Ok(store)
    }

    pub fn stats(&self) -> Result<StoreStats> {
        let conn = self.connect()?;
        let indexed_files: usize =
            conn.query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))?;
        let clone_buckets: usize = conn.query_row(
            "SELECT COUNT(DISTINCT normalized_hash) FROM clone_fingerprints",
            [],
            |row| row.get(0),
        )?;
        let type_buckets: usize = conn.query_row(
            "SELECT COUNT(DISTINCT shape_hash) FROM type_shapes",
            [],
            |row| row.get(0),
        )?;
        let sessions_tracked: usize =
            conn.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))?;
        let findings_cache_entries: usize =
            conn.query_row("SELECT COUNT(*) FROM findings_cache", [], |row| row.get(0))?;
        Ok(StoreStats {
            indexed_files,
            clone_buckets,
            type_buckets,
            sessions_tracked,
            findings_cache_entries,
        })
    }

    pub fn upsert_file_document(&self, document: &FileDocument) -> Result<()> {
        let mut conn = self.connect()?;
        let tx = conn.transaction()?;
        tx.execute(
            r#"
            INSERT INTO files (
                path, digest, mtime_ms, size_bytes, generated, parse_error, indexed_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(path) DO UPDATE SET
                digest = excluded.digest,
                mtime_ms = excluded.mtime_ms,
                size_bytes = excluded.size_bytes,
                generated = excluded.generated,
                parse_error = excluded.parse_error,
                indexed_at_ms = excluded.indexed_at_ms
            "#,
            params![
                document.path,
                document.digest,
                document.mtime_ms,
                document.size_bytes as i64,
                bool_to_int(document.generated),
                document.parse_error,
                Utc::now().timestamp_millis(),
            ],
        )?;

        tx.execute(
            "DELETE FROM imports WHERE from_path = ?1",
            params![document.path],
        )?;
        tx.execute(
            "DELETE FROM public_exports WHERE source_file = ?1",
            params![document.path],
        )?;
        tx.execute(
            "DELETE FROM clone_fingerprints WHERE file_path = ?1",
            params![document.path],
        )?;
        tx.execute(
            "DELETE FROM type_shapes WHERE file_path = ?1",
            params![document.path],
        )?;

        for edge in &document.imports {
            tx.execute(
                r#"
                INSERT INTO imports (
                    from_path, specifier, to_path, is_dynamic, is_type_only, line
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
                params![
                    edge.from_path,
                    edge.specifier,
                    edge.to_path,
                    bool_to_int(edge.is_dynamic),
                    bool_to_int(edge.is_type_only),
                    edge.line as i64,
                ],
            )?;
        }

        for export in &document.exports {
            tx.execute(
                r#"
                INSERT INTO public_exports (export_name, source_file, signature)
                VALUES (?1, ?2, ?3)
                "#,
                params![export.export_name, export.source_file, export.signature],
            )?;
        }

        for fp in &document.clones {
            tx.execute(
                r#"
                INSERT INTO clone_fingerprints (
                    file_path, symbol, kind, start_line, end_line,
                    normalized_hash, simhash, token_count, statement_count, tokens_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                "#,
                params![
                    fp.file_path,
                    fp.symbol,
                    fp.kind,
                    fp.start_line as i64,
                    fp.end_line as i64,
                    fp.normalized_hash,
                    fp.simhash as i64,
                    fp.token_count as i64,
                    fp.statement_count as i64,
                    serde_json::to_string(&fp.normalized_tokens)?,
                ],
            )?;
        }

        for shape in &document.type_shapes {
            tx.execute(
                r#"
                INSERT INTO type_shapes (
                    file_path, symbol, shape_hash, fingerprint_json, depth, suppressed
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
                params![
                    shape.file_path,
                    shape.symbol,
                    shape.shape_hash,
                    shape.fingerprint_json,
                    shape.depth as i64,
                    bool_to_int(shape.suppressed),
                ],
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    pub fn remove_file(&self, relative_path: &str) -> Result<()> {
        let mut conn = self.connect()?;
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM files WHERE path = ?1", params![relative_path])?;
        tx.execute(
            "DELETE FROM imports WHERE from_path = ?1",
            params![relative_path],
        )?;
        tx.execute(
            "DELETE FROM public_exports WHERE source_file = ?1",
            params![relative_path],
        )?;
        tx.execute(
            "DELETE FROM clone_fingerprints WHERE file_path = ?1",
            params![relative_path],
        )?;
        tx.execute(
            "DELETE FROM type_shapes WHERE file_path = ?1",
            params![relative_path],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn load_clone_fingerprints(&self) -> Result<Vec<CloneFingerprint>> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT file_path, symbol, kind, start_line, end_line,
                   normalized_hash, simhash, token_count, statement_count, tokens_json
            FROM clone_fingerprints
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            let tokens_json: String = row.get(9)?;
            let normalized_tokens = serde_json::from_str(&tokens_json).unwrap_or_default();
            Ok(CloneFingerprint {
                file_path: row.get(0)?,
                symbol: row.get(1)?,
                kind: row.get(2)?,
                start_line: row.get::<_, i64>(3)? as u32,
                end_line: row.get::<_, i64>(4)? as u32,
                normalized_hash: row.get(5)?,
                simhash: row.get::<_, i64>(6)? as u64,
                token_count: row.get::<_, i64>(7)? as usize,
                statement_count: row.get::<_, i64>(8)? as usize,
                normalized_tokens,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn load_type_shapes(&self) -> Result<Vec<TypeShapeRecord>> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT file_path, symbol, shape_hash, fingerprint_json, depth, suppressed
            FROM type_shapes
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(TypeShapeRecord {
                file_path: row.get(0)?,
                symbol: row.get(1)?,
                shape_hash: row.get(2)?,
                fingerprint_json: row.get(3)?,
                depth: row.get::<_, i64>(4)? as u8,
                suppressed: row.get::<_, i64>(5)? != 0,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn load_import_edges(&self) -> Result<Vec<ImportEdge>> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            "SELECT from_path, specifier, to_path, is_dynamic, is_type_only, line FROM imports",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ImportEdge {
                from_path: row.get(0)?,
                specifier: row.get(1)?,
                to_path: row.get(2)?,
                is_dynamic: row.get::<_, i64>(3)? != 0,
                is_type_only: row.get::<_, i64>(4)? != 0,
                line: row.get::<_, i64>(5)? as u32,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn load_public_exports(&self) -> Result<Vec<PublicApiSymbol>> {
        self.load_public_exports_limited(usize::MAX)
    }

    pub fn load_public_exports_limited(&self, limit: usize) -> Result<Vec<PublicApiSymbol>> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            "SELECT export_name, source_file, signature FROM public_exports ORDER BY source_file, export_name LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            Ok(PublicApiSymbol {
                export_name: row.get(0)?,
                source_file: row.get(1)?,
                signature: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn count_public_exports(&self) -> Result<usize> {
        let conn = self.connect()?;
        let count = conn.query_row("SELECT COUNT(*) FROM public_exports", [], |row| {
            row.get::<_, i64>(0)
        })?;
        Ok(count as usize)
    }

    pub fn read_api_baseline(&self) -> Result<BTreeMap<(String, String), String>> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            "SELECT export_name, source_file, signature FROM api_baseline ORDER BY source_file, export_name",
        )?;
        let rows = stmt.query_map([], |row| Ok(((row.get(0)?, row.get(1)?), row.get(2)?)))?;
        Ok(rows.collect::<std::result::Result<BTreeMap<_, _>, _>>()?)
    }

    pub fn write_api_baseline(&self, exports: &[PublicApiSymbol], snapshot_id: &str) -> Result<()> {
        let mut conn = self.connect()?;
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM api_baseline", [])?;
        for export in exports {
            tx.execute(
                r#"
                INSERT INTO api_baseline (export_name, source_file, signature, snapshot_id, updated_at_ms)
                VALUES (?1, ?2, ?3, ?4, ?5)
                "#,
                params![
                    export.export_name,
                    export.source_file,
                    export.signature,
                    snapshot_id,
                    Utc::now().timestamp_millis(),
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn upsert_session(&self, snapshot: &SessionSnapshot) -> Result<()> {
        let conn = self.connect()?;
        conn.execute(
            r#"
            INSERT INTO sessions (
                session_id, last_seen_ms, status, touched_files_json, touched_cone_json, parent_session_id
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(session_id) DO UPDATE SET
                last_seen_ms = excluded.last_seen_ms,
                status = excluded.status,
                touched_files_json = excluded.touched_files_json,
                touched_cone_json = excluded.touched_cone_json,
                parent_session_id = excluded.parent_session_id
            "#,
            params![
                snapshot.session_id,
                snapshot.last_seen_ms,
                snapshot.status,
                serde_json::to_string(&snapshot.touched_files)?,
                serde_json::to_string(&snapshot.touched_cone)?,
                snapshot.parent_session_id,
            ],
        )?;
        Ok(())
    }

    pub fn upsert_correlation_metadata(
        &self,
        owner_kind: &str,
        owner_id: &str,
        correlation: &FleetCorrelation,
    ) -> Result<()> {
        let conn = self.connect()?;
        conn.execute(
            r#"
            INSERT INTO correlation_metadata (
                owner_kind, owner_id, payload_json, updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(owner_kind, owner_id) DO UPDATE SET
                payload_json = excluded.payload_json,
                updated_at_ms = excluded.updated_at_ms
            "#,
            params![
                owner_kind,
                owner_id,
                serde_json::to_string(correlation)?,
                Utc::now().timestamp_millis(),
            ],
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn correlation_metadata(
        &self,
        owner_kind: &str,
        owner_id: &str,
    ) -> Result<Option<FleetCorrelation>> {
        let conn = self.connect()?;
        let payload = conn
            .query_row(
                "SELECT payload_json FROM correlation_metadata WHERE owner_kind = ?1 AND owner_id = ?2",
                params![owner_kind, owner_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        payload
            .map(|value| serde_json::from_str(&value).context("decode correlation metadata"))
            .transpose()
    }

    #[cfg(test)]
    pub fn upsert_index_job(&self, job: &IndexJobRecord) -> Result<()> {
        let conn = self.connect()?;
        conn.execute(
            r#"
            INSERT INTO index_jobs (
                id, kind, strategy, status, cursor_json, lease_owner, lease_expires_at_ms,
                processed_count, inserted_count, error_summary, created_at_ms, updated_at_ms,
                started_at_ms, finished_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            ON CONFLICT(id) DO UPDATE SET
                kind = excluded.kind,
                strategy = excluded.strategy,
                status = excluded.status,
                cursor_json = excluded.cursor_json,
                lease_owner = excluded.lease_owner,
                lease_expires_at_ms = excluded.lease_expires_at_ms,
                processed_count = excluded.processed_count,
                inserted_count = excluded.inserted_count,
                error_summary = excluded.error_summary,
                updated_at_ms = excluded.updated_at_ms,
                started_at_ms = excluded.started_at_ms,
                finished_at_ms = excluded.finished_at_ms
            "#,
            params![
                job.id,
                job.kind,
                job.strategy,
                job.status,
                job.cursor_json,
                job.lease_owner,
                job.lease_expires_at_ms,
                job.processed_count,
                job.inserted_count,
                job.error_summary,
                job.created_at_ms,
                job.updated_at_ms,
                job.started_at_ms,
                job.finished_at_ms,
            ],
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn index_job(&self, id: &str) -> Result<Option<IndexJobRecord>> {
        let conn = self.connect()?;
        conn.query_row(
            r#"
            SELECT id, kind, strategy, status, cursor_json, lease_owner, lease_expires_at_ms,
                   processed_count, inserted_count, error_summary, created_at_ms, updated_at_ms,
                   started_at_ms, finished_at_ms
            FROM index_jobs
            WHERE id = ?1
            "#,
            params![id],
            |row| {
                Ok(IndexJobRecord {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    strategy: row.get(2)?,
                    status: row.get(3)?,
                    cursor_json: row.get(4)?,
                    lease_owner: row.get(5)?,
                    lease_expires_at_ms: row.get(6)?,
                    processed_count: row.get(7)?,
                    inserted_count: row.get(8)?,
                    error_summary: row.get(9)?,
                    created_at_ms: row.get(10)?,
                    updated_at_ms: row.get(11)?,
                    started_at_ms: row.get(12)?,
                    finished_at_ms: row.get(13)?,
                })
            },
        )
        .optional()
        .context("read index job")
    }

    pub fn try_acquire_maintenance_lease(
        &self,
        name: &str,
        owner: &str,
        lease_expires_at_ms: i64,
        now_ms: i64,
    ) -> Result<bool> {
        let conn = self.connect()?;
        let changed = conn.execute(
            r#"
            INSERT INTO maintenance_leases (name, owner, lease_expires_at_ms, updated_at_ms)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(name) DO UPDATE SET
                owner = excluded.owner,
                lease_expires_at_ms = excluded.lease_expires_at_ms,
                updated_at_ms = excluded.updated_at_ms
            WHERE maintenance_leases.lease_expires_at_ms <= ?4
            "#,
            params![name, owner, lease_expires_at_ms, now_ms],
        )?;
        Ok(changed > 0)
    }

    pub fn release_maintenance_lease(&self, name: &str, owner: &str) -> Result<()> {
        let conn = self.connect()?;
        conn.execute(
            "DELETE FROM maintenance_leases WHERE name = ?1 AND owner = ?2",
            params![name, owner],
        )?;
        Ok(())
    }

    pub fn load_sessions(&self) -> Result<Vec<SessionSnapshot>> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT session_id, last_seen_ms, status, touched_files_json, touched_cone_json, parent_session_id
            FROM sessions
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            let touched_files_json: String = row.get(3)?;
            let touched_cone_json: String = row.get(4)?;
            Ok(SessionSnapshot {
                session_id: row.get(0)?,
                last_seen_ms: row.get(1)?,
                status: row.get(2)?,
                touched_files: serde_json::from_str(&touched_files_json).unwrap_or_default(),
                touched_cone: serde_json::from_str(&touched_cone_json).unwrap_or_default(),
                parent_session_id: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn append_event<S: Serialize>(&self, kind: &str, payload: &S) -> Result<()> {
        let conn = self.connect()?;
        conn.execute(
            "INSERT INTO event_log (ts_ms, kind, payload_json) VALUES (?1, ?2, ?3)",
            params![
                Utc::now().timestamp_millis(),
                kind,
                serde_json::to_string(payload)?
            ],
        )?;
        conn.execute(
            r#"
            DELETE FROM event_log
            WHERE seq NOT IN (
                SELECT seq FROM event_log ORDER BY seq DESC LIMIT 10000
            )
            "#,
            [],
        )?;
        Ok(())
    }

    pub fn prune(&self, retain_days: i64) -> Result<Vec<String>> {
        let conn = self.connect()?;
        let cutoff_ms = Utc::now().timestamp_millis() - retain_days.max(1) * 24 * 60 * 60 * 1_000;
        let removed_logs =
            conn.execute("DELETE FROM event_log WHERE ts_ms < ?1", params![cutoff_ms])?;
        let removed_sessions = conn.execute(
            "DELETE FROM sessions WHERE last_seen_ms < ?1",
            params![cutoff_ms],
        )?;
        Ok(vec![
            format!("pruned {removed_logs} event log rows"),
            format!("pruned {removed_sessions} stale session rows"),
        ])
    }

    pub fn all_files(&self) -> Result<Vec<String>> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare("SELECT path FROM files ORDER BY path")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn file_digest(&self, path: &str) -> Result<Option<String>> {
        let conn = self.connect()?;
        let digest = conn
            .query_row(
                "SELECT digest FROM files WHERE path = ?1",
                params![path],
                |row| row.get(0),
            )
            .optional()?;
        Ok(digest)
    }

    pub fn cache_findings<T: Serialize>(&self, cache_key: &str, findings: &T) -> Result<()> {
        let conn = self.connect()?;
        conn.execute(
            r#"
            INSERT INTO findings_cache (cache_key, payload_json, updated_at_ms)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(cache_key) DO UPDATE SET
                payload_json = excluded.payload_json,
                updated_at_ms = excluded.updated_at_ms
            "#,
            params![
                cache_key,
                serde_json::to_string(findings)?,
                Utc::now().timestamp_millis(),
            ],
        )?;
        Ok(())
    }

    pub fn clear_index(&self) -> Result<()> {
        let conn = self.connect()?;
        conn.execute_batch(
            r#"
            DELETE FROM imports;
            DELETE FROM public_exports;
            DELETE FROM clone_fingerprints;
            DELETE FROM type_shapes;
            DELETE FROM files;
            DELETE FROM findings_cache;
            "#,
        )?;
        Ok(())
    }

    pub fn vacuum(&self) -> Result<()> {
        let conn = self.connect()?;
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")?;
        Ok(())
    }

    fn connect(&self) -> Result<Connection> {
        let conn = Connection::open(&self.db_path).with_context(|| {
            format!("failed to open sqlite database: {}", self.db_path.display())
        })?;
        conn.busy_timeout(Duration::from_millis(1_500))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "temp_store", "MEMORY")?;
        Ok(conn)
    }

    fn migrate_schema(&self) -> Result<()> {
        let conn = self.connect()?;
        let current_version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if current_version > CURRENT_SCHEMA_VERSION {
            anyhow::bail!(
                "codemem store schema version {current_version} is newer than supported version {CURRENT_SCHEMA_VERSION}"
            );
        }

        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS files (
                path TEXT PRIMARY KEY,
                digest TEXT NOT NULL,
                mtime_ms INTEGER NOT NULL,
                size_bytes INTEGER NOT NULL,
                generated INTEGER NOT NULL,
                parse_error TEXT,
                indexed_at_ms INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS imports (
                from_path TEXT NOT NULL,
                specifier TEXT NOT NULL,
                to_path TEXT,
                is_dynamic INTEGER NOT NULL,
                is_type_only INTEGER NOT NULL,
                line INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_imports_from_path ON imports(from_path);
            CREATE INDEX IF NOT EXISTS idx_imports_to_path ON imports(to_path);

            CREATE TABLE IF NOT EXISTS public_exports (
                export_name TEXT NOT NULL,
                source_file TEXT NOT NULL,
                signature TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_public_exports_source ON public_exports(source_file);

            CREATE TABLE IF NOT EXISTS clone_fingerprints (
                file_path TEXT NOT NULL,
                symbol TEXT NOT NULL,
                kind TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                normalized_hash TEXT NOT NULL,
                simhash INTEGER NOT NULL,
                token_count INTEGER NOT NULL,
                statement_count INTEGER NOT NULL,
                tokens_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_clone_hash ON clone_fingerprints(normalized_hash);
            CREATE INDEX IF NOT EXISTS idx_clone_simhash ON clone_fingerprints(simhash);

            CREATE TABLE IF NOT EXISTS type_shapes (
                file_path TEXT NOT NULL,
                symbol TEXT NOT NULL,
                shape_hash TEXT NOT NULL,
                fingerprint_json TEXT NOT NULL,
                depth INTEGER NOT NULL,
                suppressed INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_type_shape_hash ON type_shapes(shape_hash);

            CREATE TABLE IF NOT EXISTS api_baseline (
                export_name TEXT NOT NULL,
                source_file TEXT NOT NULL,
                signature TEXT NOT NULL,
                snapshot_id TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY(export_name, source_file)
            );

            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                last_seen_ms INTEGER NOT NULL,
                status TEXT NOT NULL,
                touched_files_json TEXT NOT NULL,
                touched_cone_json TEXT NOT NULL,
                parent_session_id TEXT
            );

            CREATE TABLE IF NOT EXISTS correlation_metadata (
                owner_kind TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY(owner_kind, owner_id)
            );
            CREATE INDEX IF NOT EXISTS idx_correlation_owner ON correlation_metadata(owner_kind, owner_id);

            CREATE TABLE IF NOT EXISTS index_jobs (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                strategy TEXT NOT NULL,
                status TEXT NOT NULL,
                cursor_json TEXT NOT NULL,
                lease_owner TEXT,
                lease_expires_at_ms INTEGER,
                processed_count INTEGER NOT NULL,
                inserted_count INTEGER NOT NULL,
                error_summary TEXT,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                started_at_ms INTEGER,
                finished_at_ms INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_index_jobs_status ON index_jobs(status);
            CREATE INDEX IF NOT EXISTS idx_index_jobs_lease ON index_jobs(lease_expires_at_ms);

            CREATE TABLE IF NOT EXISTS maintenance_leases (
                name TEXT PRIMARY KEY,
                owner TEXT NOT NULL,
                lease_expires_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_maintenance_leases_expires ON maintenance_leases(lease_expires_at_ms);

            CREATE TABLE IF NOT EXISTS findings_cache (
                cache_key TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS event_log (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                ts_ms INTEGER NOT NULL,
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL
            );
            "#,
        )?;
        if current_version < CURRENT_SCHEMA_VERSION {
            conn.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)?;
        }
        Ok(())
    }
}

fn bool_to_int(value: bool) -> i64 {
    if value { 1 } else { 0 }
}

#[cfg(test)]
mod tests {
    use super::Store;
    use crate::model::{FileDocument, IndexJobRecord};
    use crate::protocol::FleetCorrelation;
    use rusqlite::{Connection, params};
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn open_sets_user_version_on_empty_store() {
        let state_dir = temp_dir("empty");
        fs::create_dir_all(&state_dir).expect("create state dir");

        let store = Store::open(&state_dir).expect("open store");

        assert_eq!(sqlite_user_version(&store.db_path), 1);
    }

    #[test]
    fn open_migrates_seeded_zero_version_store_without_losing_rows() {
        let state_dir = temp_dir("seeded");
        fs::create_dir_all(&state_dir).expect("create state dir");
        let db_path = state_dir.join("codemem.sqlite3");
        seed_zero_version_store(&db_path);

        let store = Store::open(&state_dir).expect("open store");
        let stats = store.stats().expect("store stats");

        assert_eq!(sqlite_user_version(&store.db_path), 1);
        assert_eq!(stats.indexed_files, 1);
        assert_eq!(
            store
                .file_digest("src/index.ts")
                .expect("file digest")
                .as_deref(),
            Some("digest-a")
        );
    }

    #[test]
    fn reopen_preserves_user_version_and_seeded_rows() {
        let state_dir = temp_dir("reopen");
        fs::create_dir_all(&state_dir).expect("create state dir");
        let store = Store::open(&state_dir).expect("open store");
        store
            .upsert_file_document(&FileDocument {
                path: "src/index.ts".into(),
                digest: "digest-b".into(),
                mtime_ms: 1,
                size_bytes: 10,
                generated: false,
                parse_error: None,
                imports: Vec::new(),
                exports: Vec::new(),
                clones: Vec::new(),
                type_shapes: Vec::new(),
            })
            .expect("upsert file");

        let reopened = Store::open(&state_dir).expect("reopen store");

        assert_eq!(sqlite_user_version(&reopened.db_path), 1);
        assert_eq!(
            reopened
                .file_digest("src/index.ts")
                .expect("file digest")
                .as_deref(),
            Some("digest-b")
        );
    }

    #[test]
    fn stores_correlation_metadata_outside_graph_identity_tables() {
        let state_dir = temp_dir("correlation");
        fs::create_dir_all(&state_dir).expect("create state dir");
        let store = Store::open(&state_dir).expect("open store");
        let correlation = FleetCorrelation {
            workspace_id: Some("workspace-a".into()),
            plan_id: Some("plan-a".into()),
            plan_slug: Some("plan-slug-a".into()),
            wave_id: Some("W5".into()),
            agent_run_id: Some("agent-run-a".into()),
            correlation_id: Some("corr-a".into()),
            tool_call_id: Some("tool-call-a".into()),
            artifact_ref: Some("artifact-a".into()),
            lifecycle_object_id: Some("lifecycle-a".into()),
            concord_event_id: Some("concord-a".into()),
            fleet_run_id: Some("fleet-a".into()),
            spine_seq: Some(7),
        };

        store
            .upsert_correlation_metadata("session", "session-a", &correlation)
            .expect("persist correlation");

        assert_eq!(
            store
                .correlation_metadata("session", "session-a")
                .expect("read correlation"),
            Some(correlation)
        );
        assert!(!table_has_column(&store.db_path, "files", "correlation_id"));
        assert!(!table_has_column(&store.db_path, "imports", "correlation_id"));
        assert!(!table_has_column(&store.db_path, "public_exports", "correlation_id"));
        assert!(!table_has_column(&store.db_path, "clone_fingerprints", "correlation_id"));
        assert!(!table_has_column(&store.db_path, "type_shapes", "correlation_id"));
    }

    #[test]
    fn persists_index_job_progress_and_lease_metadata() {
        let state_dir = temp_dir("index-job");
        fs::create_dir_all(&state_dir).expect("create state dir");
        let store = Store::open(&state_dir).expect("open store");
        let job = IndexJobRecord {
            id: "job-a".into(),
            kind: "bootstrap".into(),
            strategy: "bounded".into(),
            status: "running".into(),
            cursor_json: "{\"next\":\"src/a.ts\"}".into(),
            lease_owner: Some("daemon-a".into()),
            lease_expires_at_ms: Some(2_000),
            processed_count: 5,
            inserted_count: 4,
            error_summary: None,
            created_at_ms: 1_000,
            updated_at_ms: 1_500,
            started_at_ms: Some(1_100),
            finished_at_ms: None,
        };

        store.upsert_index_job(&job).expect("upsert index job");

        assert_eq!(store.index_job("job-a").expect("read index job"), Some(job));
    }

    #[test]
    fn maintenance_leases_exclude_active_writers_and_recover_stale_leases() {
        let state_dir = temp_dir("maintenance-lease");
        fs::create_dir_all(&state_dir).expect("create state dir");
        let store = Store::open(&state_dir).expect("open store");

        assert!(
            store
                .try_acquire_maintenance_lease("rebuild", "owner-a", 2_000, 1_000)
                .expect("acquire first lease")
        );
        assert!(
            !store
                .try_acquire_maintenance_lease("rebuild", "owner-b", 3_000, 1_500)
                .expect("active lease blocks second owner")
        );
        assert!(
            store
                .try_acquire_maintenance_lease("rebuild", "owner-b", 4_000, 2_500)
                .expect("stale lease is recoverable")
        );
        store
            .release_maintenance_lease("rebuild", "owner-b")
            .expect("release lease");
        assert!(
            store
                .try_acquire_maintenance_lease("rebuild", "owner-c", 5_000, 3_000)
                .expect("released lease can be reacquired")
        );
    }

    #[test]
    fn open_rejects_newer_schema_version() {
        let state_dir = temp_dir("future");
        fs::create_dir_all(&state_dir).expect("create state dir");
        let db_path = state_dir.join("codemem.sqlite3");
        let conn = Connection::open(&db_path).expect("open sqlite");
        conn.execute_batch("PRAGMA user_version = 999;")
            .expect("set future version");
        drop(conn);

        let error = match Store::open(&state_dir) {
            Ok(_) => panic!("future schema should fail"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("newer than supported version"));
    }

    fn seed_zero_version_store(db_path: &Path) {
        let conn = Connection::open(db_path).expect("open sqlite");
        conn.execute_batch(
            r#"
            CREATE TABLE files (
                path TEXT PRIMARY KEY,
                digest TEXT NOT NULL,
                mtime_ms INTEGER NOT NULL,
                size_bytes INTEGER NOT NULL,
                generated INTEGER NOT NULL,
                parse_error TEXT,
                indexed_at_ms INTEGER NOT NULL
            );

            CREATE TABLE imports (
                from_path TEXT NOT NULL,
                specifier TEXT NOT NULL,
                to_path TEXT,
                is_dynamic INTEGER NOT NULL,
                is_type_only INTEGER NOT NULL,
                line INTEGER NOT NULL
            );

            CREATE TABLE public_exports (
                export_name TEXT NOT NULL,
                source_file TEXT NOT NULL,
                signature TEXT NOT NULL
            );

            CREATE TABLE clone_fingerprints (
                file_path TEXT NOT NULL,
                symbol TEXT NOT NULL,
                kind TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                normalized_hash TEXT NOT NULL,
                simhash INTEGER NOT NULL,
                token_count INTEGER NOT NULL,
                statement_count INTEGER NOT NULL,
                tokens_json TEXT NOT NULL
            );

            CREATE TABLE type_shapes (
                file_path TEXT NOT NULL,
                symbol TEXT NOT NULL,
                shape_hash TEXT NOT NULL,
                fingerprint_json TEXT NOT NULL,
                depth INTEGER NOT NULL,
                suppressed INTEGER NOT NULL
            );

            CREATE TABLE api_baseline (
                export_name TEXT NOT NULL,
                source_file TEXT NOT NULL,
                signature TEXT NOT NULL,
                snapshot_id TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY(export_name, source_file)
            );

            CREATE TABLE sessions (
                session_id TEXT PRIMARY KEY,
                last_seen_ms INTEGER NOT NULL,
                status TEXT NOT NULL,
                touched_files_json TEXT NOT NULL,
                touched_cone_json TEXT NOT NULL,
                parent_session_id TEXT
            );

            CREATE TABLE findings_cache (
                cache_key TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );

            CREATE TABLE event_log (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                ts_ms INTEGER NOT NULL,
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL
            );
            PRAGMA user_version = 0;
            "#,
        )
        .expect("create seeded schema");
        conn.execute(
            r#"
            INSERT INTO files (path, digest, mtime_ms, size_bytes, generated, parse_error, indexed_at_ms)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
            params!["src/index.ts", "digest-a", 1_i64, 10_i64, 0_i64, Option::<String>::None, 2_i64],
        )
        .expect("insert seeded file");
    }

    fn table_has_column(db_path: &Path, table: &str, column: &str) -> bool {
        let conn = Connection::open(db_path).expect("open sqlite");
        let mut statement = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("prepare table info");
        let mut rows = statement.query([]).expect("query table info");
        while let Some(row) = rows.next().expect("read table info") {
            let name: String = row.get(1).expect("column name");
            if name == column {
                return true;
            }
        }
        false
    }

    fn sqlite_user_version(db_path: &Path) -> i64 {
        let conn = Connection::open(db_path).expect("open sqlite");
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read user version")
    }

    fn temp_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "codemem-store-{name}-{}-{unique}",
            std::process::id()
        ))
    }
}
