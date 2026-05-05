use crate::{
    config::{PackageBoundary, ProjectConfig, normalize_rel},
    detectors::{clones::CloneDetector, types::TypeShapeDetector},
    graph::ModuleGraph,
    model::{
        DriftMap, Evidence, FileDocument, Finding, ImportEdge, PublicApiSymbol, Severity,
        StoreStats,
    },
    protocol::FleetCorrelation,
    session_conflicts::SessionConflictTracker,
    store::Store,
};
use anyhow::{Context, Result, bail};
use blake3::hash;
use globset::GlobSet;
use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;
use parking_lot::Mutex;
use regex::Regex;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicI64, AtomicUsize, Ordering},
    },
    time::Instant,
};
use tokio::sync::mpsc::{self, error::TrySendError};
use walkdir::WalkDir;

#[derive(Debug, Clone)]
pub struct CheckSummary {
    pub findings: Vec<Finding>,
    pub truncated: bool,
    pub indexed_at_ms: i64,
    pub stats: StoreStats,
    pub scan_latency_ms: u64,
}

#[derive(Debug, Clone)]
pub struct DriftMapSummary {
    pub map: DriftMap,
    pub indexed_at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct ConflictSummary {
    pub findings: Vec<Finding>,
    pub indexed_at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct ImpactConeSummary {
    pub path: String,
    pub depth: usize,
    pub files: Vec<String>,
    pub indexed_at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct ChangeRiskSummary {
    pub score: u32,
    pub level: String,
    pub paths: Vec<String>,
    pub depth: usize,
    pub reasons: Vec<ChangeRiskReason>,
    pub impacted_files: Vec<String>,
    pub focus: Vec<ChangeRiskFocusItem>,
    pub indexed_at_ms: i64,
    pub stats: ChangeRiskStats,
}

#[derive(Debug, Clone)]
pub struct ChangeRiskReason {
    pub kind: String,
    pub severity: Severity,
    pub score: u32,
    pub detail: String,
    pub files: Vec<String>,
    pub symbols: Vec<String>,
    pub finding_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ChangeRiskFocusItem {
    pub target: String,
    pub target_kind: String,
    pub severity: Severity,
    pub confidence: f64,
    pub score: u32,
    pub reasons: Vec<String>,
    pub evidence: Vec<Evidence>,
    pub finding_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ChangeRiskStats {
    pub impacted_files: usize,
    pub reverse_dependents: usize,
    pub public_exports: usize,
    pub findings: usize,
    pub session_conflicts: usize,
}

#[derive(Debug, Clone)]
pub struct ApiSurfaceSummary {
    pub exports: Vec<PublicApiSymbol>,
    pub total: usize,
    pub truncated: bool,
    pub indexed_at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct LayerBoundarySummary {
    pub boundaries: Vec<PackageBoundary>,
    pub cycles: Vec<Finding>,
    pub indexed_at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct LockfileSummary {
    pub lockfiles: Vec<LockfileInfo>,
    pub indexed_at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct LockfileInfo {
    pub path: String,
    pub digest: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct MaintainAction {
    pub kind: String,
    pub detail: String,
    pub estimated_bytes: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct MaintainSummary {
    pub actions: Vec<MaintainAction>,
    pub applied: bool,
}

#[derive(Debug, Clone)]
pub struct RebuildSummary {
    pub would_rebuild: bool,
    pub reason: String,
}

#[derive(Debug, Clone)]
struct IndexWorkItem {
    session_id: String,
    files: Vec<String>,
    reason: String,
    correlation: FleetCorrelation,
}

pub struct Indexer {
    project_root: PathBuf,
    config: Arc<ProjectConfig>,
    ignore: GlobSet,
    store: Arc<Store>,
    sessions: Arc<SessionConflictTracker>,
    clone_detector: CloneDetector,
    type_shape_detector: TypeShapeDetector,
    queue_depth: AtomicUsize,
    dropped_batches: AtomicUsize,
    failed_batches: AtomicUsize,
    indexed_at_ms: AtomicI64,
    worker_rx: Mutex<Option<mpsc::Receiver<IndexWorkItem>>>,
    worker_tx: mpsc::Sender<IndexWorkItem>,
}

impl Indexer {
    pub fn new(
        project_root: PathBuf,
        _state_dir: PathBuf,
        config: Arc<ProjectConfig>,
        store: Arc<Store>,
        sessions: Arc<SessionConflictTracker>,
    ) -> Result<Arc<Self>> {
        let ignore = config.ignore_set()?;
        let (worker_tx, worker_rx) = mpsc::channel(256);
        Ok(Arc::new(Self {
            project_root,
            config: Arc::clone(&config),
            ignore,
            store,
            sessions,
            clone_detector: CloneDetector::new(&config),
            type_shape_detector: TypeShapeDetector::new(&config),
            queue_depth: AtomicUsize::new(0),
            dropped_batches: AtomicUsize::new(0),
            failed_batches: AtomicUsize::new(0),
            indexed_at_ms: AtomicI64::new(0),
            worker_rx: Mutex::new(Some(worker_rx)),
            worker_tx,
        }))
    }

    pub fn start(self: &Arc<Self>) {
        if let Some(mut rx) = self.worker_rx.lock().take() {
            let this = Arc::clone(self);
            tokio::spawn(async move {
                while let Some(item) = rx.recv().await {
                    let _ = this.store.upsert_correlation_metadata(
                        "index_batch",
                        &format!("{}:{}", item.session_id, item.reason),
                        &item.correlation,
                    );
                    let result = this
                        .index_paths_now(&item.session_id, item.files.clone(), &item.reason)
                        .await;
                    if result.is_err() {
                        this.failed_batches.fetch_add(1, Ordering::SeqCst);
                    }
                    this.queue_depth.fetch_sub(1, Ordering::SeqCst);
                }
            });
        }

        // Broad bootstrap indexing is explicit job/CLI work, never daemon startup work.
    }

    pub fn queue_depth(&self) -> usize {
        self.queue_depth.load(Ordering::SeqCst)
    }

    pub fn dropped_batches(&self) -> usize {
        self.dropped_batches.load(Ordering::SeqCst)
    }

    pub fn failed_batches(&self) -> usize {
        self.failed_batches.load(Ordering::SeqCst)
    }

    pub fn indexed_at_ms(&self) -> i64 {
        self.indexed_at_ms.load(Ordering::SeqCst)
    }

    pub fn store_stats(&self) -> Result<StoreStats> {
        self.store.stats()
    }

    pub fn record_correlation_metadata(
        &self,
        owner_kind: &str,
        owner_id: &str,
        correlation: &FleetCorrelation,
    ) -> Result<()> {
        self.store
            .upsert_correlation_metadata(owner_kind, owner_id, correlation)
    }

    pub async fn enqueue_files(
        &self,
        session_id: String,
        files: Vec<String>,
        reason: String,
        correlation: FleetCorrelation,
    ) -> Result<()> {
        let files = self.normalize_candidates(files);
        if files.is_empty() {
            return Ok(());
        }
        self.store
            .upsert_correlation_metadata("session", &session_id, &correlation)?;
        match self.worker_tx.try_send(IndexWorkItem {
                session_id,
                files,
                reason,
                correlation,
            }) {
            Ok(()) => {
                self.queue_depth.fetch_add(1, Ordering::SeqCst);
            }
            Err(TrySendError::Full(_)) => {
                self.dropped_batches.fetch_add(1, Ordering::SeqCst);
            }
            Err(TrySendError::Closed(_)) => {
                return Err(anyhow::anyhow!("index queue is closed"));
            }
        }
        Ok(())
    }

    pub async fn bootstrap_scan(&self) -> Result<()> {
        let files = self.discover_source_files()?;
        if files.is_empty() {
            return Ok(());
        }
        self.index_paths_now("bootstrap", files, "bootstrap")
            .await?;
        Ok(())
    }

    pub async fn check(
        &self,
        session_id: Option<&str>,
        paths: Option<Vec<String>>,
        max_findings: usize,
        wait_for_fresh_index: bool,
    ) -> Result<CheckSummary> {
        let started = Instant::now();
        let normalized_paths = paths.map(|items| self.normalize_candidates(items));
        if wait_for_fresh_index {
            if let Some(paths) = normalized_paths.clone() {
                self.index_paths_now(session_id.unwrap_or("manual"), paths, "manual")
                    .await?;
            }
        }

        let findings =
            self.collect_findings(normalized_paths.as_ref(), session_id, max_findings)?;
        let stats = self.store.stats()?;
        let truncated = findings.len() > max_findings;
        let output = if truncated {
            findings.into_iter().take(max_findings).collect()
        } else {
            findings
        };
        self.store.cache_findings("latest_check", &output)?;
        Ok(CheckSummary {
            findings: output,
            truncated,
            indexed_at_ms: self.indexed_at_ms(),
            stats,
            scan_latency_ms: started.elapsed().as_millis() as u64,
        })
    }

    pub async fn drift_map(
        &self,
        session_id: Option<&str>,
        max_findings: usize,
    ) -> Result<DriftMapSummary> {
        let check = self.check(session_id, None, max_findings, false).await?;
        let graph = ModuleGraph::load(&self.project_root, &self.config, &self.store)?;
        let map = graph
            .drift_map(check.findings.clone())
            .finish(check.findings);
        Ok(DriftMapSummary {
            map,
            indexed_at_ms: self.indexed_at_ms(),
        })
    }

    pub async fn conflicts(
        &self,
        session_id: Option<&str>,
        max_findings: usize,
    ) -> Result<ConflictSummary> {
        if !self.config.layers.session_conflicts {
            return Ok(ConflictSummary {
                findings: Vec::new(),
                indexed_at_ms: self.indexed_at_ms(),
            });
        }

        let findings = self.sessions.conflicts(
            session_id,
            self.config.thresholds.session_conflict_overlap,
            max_findings,
        );
        Ok(ConflictSummary {
            findings,
            indexed_at_ms: self.indexed_at_ms(),
        })
    }

    pub fn impact_cone(&self, path: &str, depth: usize) -> Result<ImpactConeSummary> {
        let Some(normalized_path) = self.normalize_candidate_file(path) else {
            bail!("impact-cone path is outside project root or ignored: {path}");
        };
        let graph = ModuleGraph::load(&self.project_root, &self.config, &self.store)?;
        let files: Vec<String> = graph
            .dependency_cone(std::slice::from_ref(&normalized_path), depth)
            .into_iter()
            .collect();
        if files.is_empty() {
            bail!("impact-cone path is not indexed: {normalized_path}");
        }
        Ok(ImpactConeSummary {
            path: normalized_path,
            depth,
            files,
            indexed_at_ms: self.indexed_at_ms(),
        })
    }

    pub fn change_risk(
        &self,
        paths: Vec<String>,
        depth: usize,
        session_id: Option<&str>,
        max_findings: usize,
    ) -> Result<ChangeRiskSummary> {
        let paths = self.normalize_candidates(paths);
        let graph = ModuleGraph::load(&self.project_root, &self.config, &self.store)?;
        let impacted_files = graph
            .dependency_cone(&paths, depth)
            .into_iter()
            .collect::<Vec<_>>();
        let impacted_set = impacted_files.iter().cloned().collect::<BTreeSet<_>>();
        let mut reasons = Vec::new();

        if impacted_files.len() > paths.len() {
            reasons.push(ChangeRiskReason {
                kind: "dependency_cone".into(),
                severity: if impacted_files.len() >= 8 {
                    Severity::Warn
                } else {
                    Severity::Info
                },
                score: ((impacted_files.len() as u32) * 4).min(30),
                detail: format!(
                    "{} files are in the depth-{depth} import-graph dependency cone",
                    impacted_files.len()
                ),
                files: impacted_files.iter().take(12).cloned().collect(),
                symbols: Vec::new(),
                finding_ids: Vec::new(),
            });
        }

        let reverse_dependents = reverse_dependents_for(&graph, &paths);
        if !reverse_dependents.is_empty() {
            reasons.push(ChangeRiskReason {
                kind: "reverse_dependents".into(),
                severity: if reverse_dependents.len() >= 4 {
                    Severity::Warn
                } else {
                    Severity::Info
                },
                score: ((reverse_dependents.len() as u32) * 8).min(30),
                detail: format!(
                    "{} files import or depend on the changed paths",
                    reverse_dependents.len()
                ),
                files: reverse_dependents.iter().take(12).cloned().collect(),
                symbols: Vec::new(),
                finding_ids: Vec::new(),
            });
        }

        let public_exports = self
            .store
            .load_public_exports()?
            .into_iter()
            .filter(|export| paths.iter().any(|path| path == &export.source_file))
            .collect::<Vec<_>>();
        if !public_exports.is_empty() {
            reasons.push(ChangeRiskReason {
                kind: "public_exports".into(),
                severity: Severity::Warn,
                score: ((public_exports.len() as u32) * 10).min(30),
                detail: format!(
                    "{} public exports are defined in changed paths",
                    public_exports.len()
                ),
                files: public_exports
                    .iter()
                    .map(|export| export.source_file.clone())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect(),
                symbols: public_exports
                    .iter()
                    .map(|export| export.export_name.clone())
                    .collect(),
                finding_ids: Vec::new(),
            });
        }

        let dynamic_import_files = impacted_files
            .iter()
            .filter(|file| graph.dynamic_import_risk_for(file))
            .cloned()
            .collect::<Vec<_>>();
        if !dynamic_import_files.is_empty() {
            reasons.push(ChangeRiskReason {
                kind: "dynamic_imports".into(),
                severity: Severity::Warn,
                score: ((dynamic_import_files.len() as u32) * 10).min(20),
                detail: format!(
                    "{} impacted files have inbound dynamic import edges",
                    dynamic_import_files.len()
                ),
                files: dynamic_import_files,
                symbols: Vec::new(),
                finding_ids: Vec::new(),
            });
        }

        let findings = self.collect_findings(Some(&impacted_files), session_id, max_findings)?;
        let api_drift = findings_by_kind(&findings, "api_drift");
        if !api_drift.is_empty() {
            reasons.push(ChangeRiskReason {
                kind: "api_drift".into(),
                severity: Severity::Error,
                score: ((api_drift.len() as u32) * 20).min(40),
                detail: format!(
                    "{} API drift findings touch the dependency cone",
                    api_drift.len()
                ),
                files: finding_files(&api_drift, &impacted_set),
                symbols: Vec::new(),
                finding_ids: api_drift
                    .iter()
                    .map(|finding| finding.stable_key())
                    .collect(),
            });
        }

        let cycles = findings_by_kind(&findings, "cycle");
        if !cycles.is_empty() {
            reasons.push(ChangeRiskReason {
                kind: "cycles".into(),
                severity: highest_severity(&cycles),
                score: ((cycles.len() as u32) * 15).min(30),
                detail: format!("{} cycle findings touch the dependency cone", cycles.len()),
                files: finding_files(&cycles, &impacted_set),
                symbols: Vec::new(),
                finding_ids: cycles.iter().map(|finding| finding.stable_key()).collect(),
            });
        }

        let session_conflicts = findings_by_kind(&findings, "session_conflict");
        if !session_conflicts.is_empty() {
            reasons.push(ChangeRiskReason {
                kind: "session_conflicts".into(),
                severity: highest_severity(&session_conflicts),
                score: ((session_conflicts.len() as u32) * 20).min(40),
                detail: format!(
                    "{} active session conflicts touch the dependency cone",
                    session_conflicts.len()
                ),
                files: finding_files(&session_conflicts, &impacted_set),
                symbols: Vec::new(),
                finding_ids: session_conflicts
                    .iter()
                    .map(|finding| finding.stable_key())
                    .collect(),
            });
        }

        let nearby_findings = findings
            .iter()
            .filter(|finding| {
                !matches!(
                    finding,
                    Finding::ApiDrift { .. }
                        | Finding::Cycle { .. }
                        | Finding::SessionConflict { .. }
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        if !nearby_findings.is_empty() {
            reasons.push(ChangeRiskReason {
                kind: "nearby_findings".into(),
                severity: highest_severity(&nearby_findings),
                score: ((nearby_findings.len() as u32) * 6).min(18),
                detail: format!(
                    "{} non-graph findings touch the dependency cone",
                    nearby_findings.len()
                ),
                files: finding_files(&nearby_findings, &impacted_set),
                symbols: Vec::new(),
                finding_ids: nearby_findings
                    .iter()
                    .map(|finding| finding.stable_key())
                    .collect(),
            });
        }

        reasons.sort_by(|left, right| {
            right
                .severity
                .score()
                .cmp(&left.severity.score())
                .then_with(|| right.score.cmp(&left.score))
                .then_with(|| left.kind.cmp(&right.kind))
        });
        let score = reasons
            .iter()
            .map(|reason| reason.score)
            .sum::<u32>()
            .min(100);
        let focus = focus_from_reasons(&reasons, max_findings.min(12));
        Ok(ChangeRiskSummary {
            score,
            level: risk_level(score).into(),
            paths,
            depth,
            reasons,
            impacted_files,
            focus,
            indexed_at_ms: self.indexed_at_ms(),
            stats: ChangeRiskStats {
                impacted_files: impacted_set.len(),
                reverse_dependents: reverse_dependents.len(),
                public_exports: public_exports.len(),
                findings: findings.len(),
                session_conflicts: session_conflicts.len(),
            },
        })
    }

    pub fn api_surface(&self, max_exports: usize) -> Result<ApiSurfaceSummary> {
        let limit = max_exports.max(1);
        let total = self.store.count_public_exports()?;
        let exports = self.store.load_public_exports_limited(limit)?;
        let truncated = total > exports.len();
        Ok(ApiSurfaceSummary {
            exports,
            total,
            truncated,
            indexed_at_ms: self.indexed_at_ms(),
        })
    }

    pub fn layer_boundaries(&self, max_findings: usize) -> Result<LayerBoundarySummary> {
        let graph = ModuleGraph::load(&self.project_root, &self.config, &self.store)?;
        let cycles = graph.package_cycle_findings(max_findings);
        Ok(LayerBoundarySummary {
            boundaries: self.config.package_boundaries.clone(),
            cycles,
            indexed_at_ms: self.indexed_at_ms(),
        })
    }

    pub fn lockfiles(&self) -> Result<LockfileSummary> {
        let mut lockfiles = Vec::new();
        for relative_path in [
            "bun.lock",
            "bun.lockb",
            "package-lock.json",
            "pnpm-lock.yaml",
            "yarn.lock",
            "Cargo.lock",
        ] {
            let absolute_path = self.project_root.join(relative_path);
            if !absolute_path.is_file() {
                continue;
            }
            let bytes = fs::read(&absolute_path)?;
            lockfiles.push(LockfileInfo {
                path: relative_path.to_string(),
                digest: hash(&bytes).to_hex().to_string(),
                size_bytes: bytes.len() as u64,
            });
        }
        Ok(LockfileSummary {
            lockfiles,
            indexed_at_ms: self.indexed_at_ms(),
        })
    }

    pub fn maintain(
        &self,
        dry_run: bool,
        prune_logs: bool,
        compact: bool,
    ) -> Result<MaintainSummary> {
        let mut actions = Vec::new();
        let stale_sessions = self.sessions.stale_sessions();
        if !stale_sessions.is_empty() {
            actions.push(MaintainAction {
                kind: "stale_sessions".into(),
                detail: format!(
                    "{} stale sessions will be pruned by retention policy",
                    stale_sessions.len()
                ),
                estimated_bytes: None,
            });
        }
        if prune_logs {
            actions.push(MaintainAction {
                kind: "prune_logs".into(),
                detail: format!(
                    "prune local event logs older than {} days",
                    self.config.telemetry.retain_days
                ),
                estimated_bytes: Some(self.config.telemetry.max_log_bytes as u64 / 2),
            });
        }
        if compact {
            actions.push(MaintainAction {
                kind: "compact".into(),
                detail: "VACUUM the sqlite store and checkpoint WAL".into(),
                estimated_bytes: None,
            });
        }
        if dry_run {
            return Ok(MaintainSummary {
                actions,
                applied: false,
            });
        }
        let lease_owner = maintenance_owner("maintain");
        if prune_logs || compact {
            self.acquire_maintenance_lease("maintain", &lease_owner)?;
        }
        if prune_logs {
            for detail in self.store.prune(self.config.telemetry.retain_days)? {
                actions.push(MaintainAction {
                    kind: "applied".into(),
                    detail,
                    estimated_bytes: None,
                });
            }
        }
        if compact {
            self.store.vacuum()?;
        }
        if prune_logs || compact {
            self.store
                .release_maintenance_lease("maintain", &lease_owner)?;
        }
        Ok(MaintainSummary {
            actions,
            applied: true,
        })
    }

    pub async fn rebuild(&self, dry_run: bool) -> Result<RebuildSummary> {
        let indexed = self.store.stats()?.indexed_files;
        let reason = if indexed == 0 {
            "no prior index exists".to_string()
        } else {
            format!("rebuild requested across {indexed} indexed files")
        };
        if dry_run {
            return Ok(RebuildSummary {
                would_rebuild: true,
                reason,
            });
        }
        let lease_owner = maintenance_owner("rebuild");
        self.acquire_maintenance_lease("rebuild", &lease_owner)?;
        self.store.clear_index()?;
        self.indexed_at_ms.store(0, Ordering::SeqCst);
        self.bootstrap_scan().await?;
        self.store
            .release_maintenance_lease("rebuild", &lease_owner)?;
        Ok(RebuildSummary {
            would_rebuild: true,
            reason,
        })
    }

    fn acquire_maintenance_lease(&self, name: &str, owner: &str) -> Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let acquired = self
            .store
            .try_acquire_maintenance_lease(name, owner, now + 5 * 60 * 1_000, now)?;
        if !acquired {
            bail!("maintenance lease is already active: {name}");
        }
        Ok(())
    }

    async fn index_paths_now(
        &self,
        session_id: &str,
        files: Vec<String>,
        reason: &str,
    ) -> Result<usize> {
        let files = self.normalize_candidates(files);
        if files.is_empty() {
            return Ok(0);
        }
        let touched_files = files.clone();
        let mut indexed = 0usize;
        for relative_path in files {
            let absolute_path = self.project_root.join(&relative_path);
            if !absolute_path.exists() {
                self.store.remove_file(&relative_path)?;
                continue;
            }
            let metadata = tokio::fs::metadata(&absolute_path)
                .await
                .with_context(|| format!("failed to stat {}", absolute_path.display()))?;
            if !metadata.is_file() {
                continue;
            }
            let source = tokio::fs::read_to_string(&absolute_path)
                .await
                .with_context(|| format!("failed to read {}", absolute_path.display()))?;
            let digest = hash(source.as_bytes()).to_hex().to_string();
            if self.store.file_digest(&relative_path)?.as_deref() == Some(digest.as_str()) {
                continue;
            }

            let generated = looks_generated(&source);
            let parse_error = syntax_probe(&absolute_path, &source);
            let imports = if self.config.layers.symbol_graph
                || self.config.layers.api_drift
                || self.config.layers.dynamic_dead_code
                || self.config.layers.session_conflicts
            {
                extract_imports(&self.project_root, &relative_path, &source)
            } else {
                Vec::new()
            };
            let exports = if self.config.layers.api_drift || self.config.layers.dynamic_dead_code {
                extract_exports(&relative_path, &source)
            } else {
                Vec::new()
            };
            let clones = self
                .clone_detector
                .analyze_file(&relative_path, &source, generated);
            let type_shapes =
                self.type_shape_detector
                    .analyze_file(&relative_path, &source, generated);
            let mtime_ms = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or_default();
            let document = FileDocument {
                path: relative_path.clone(),
                digest,
                mtime_ms,
                size_bytes: metadata.len(),
                generated,
                parse_error,
                imports,
                exports,
                clones,
                type_shapes,
            };
            self.store.upsert_file_document(&document)?;
            indexed += 1;
        }

        if indexed > 0 {
            let graph_needed = self.config.layers.symbol_graph
                || self.config.layers.api_drift
                || self.config.layers.dynamic_dead_code
                || self.config.layers.session_conflicts;
            let graph = if graph_needed {
                Some(ModuleGraph::load(
                    &self.project_root,
                    &self.config,
                    &self.store,
                )?)
            } else {
                None
            };
            if self.config.layers.session_conflicts && !touched_files.is_empty() {
                let graph = graph.as_ref().expect("graph loaded for session conflicts");
                let _ = self
                    .sessions
                    .observe(session_id, touched_files.clone(), &graph);
            }
            if self.config.layers.api_drift {
                if let Some(graph) = graph.as_ref() {
                    let _ = graph.ensure_api_baseline(&self.store);
                }
            }
            let now = chrono::Utc::now().timestamp_millis();
            self.indexed_at_ms.store(now, Ordering::SeqCst);
            self.store.append_event(
                "index.batch",
                &serde_json::json!({
                    "sessionID": session_id,
                    "indexedFiles": indexed,
                    "reason": reason,
                    "indexedAtUnixMs": now,
                }),
            )?;
        }

        Ok(indexed)
    }

    fn collect_findings(
        &self,
        path_filter: Option<&Vec<String>>,
        session_id: Option<&str>,
        max_findings: usize,
    ) -> Result<Vec<Finding>> {
        let mut findings = Vec::new();
        if self.config.layers.ast_clones || self.config.layers.simhash_clones {
            let clone_records = self.store.load_clone_fingerprints()?;
            findings.extend(self.clone_detector.detect(&clone_records, max_findings));
        }
        if self.config.layers.type_shapes {
            let type_records = self.store.load_type_shapes()?;
            findings.extend(self.type_shape_detector.detect(&type_records, max_findings));
        }

        let graph_needed = self.config.layers.symbol_graph
            || self.config.layers.dynamic_dead_code
            || self.config.layers.api_drift
            || self.config.layers.session_conflicts;
        let graph = if graph_needed {
            Some(ModuleGraph::load(
                &self.project_root,
                &self.config,
                &self.store,
            )?)
        } else {
            None
        };
        if self.config.layers.symbol_graph {
            let graph = graph.as_ref().expect("graph loaded for symbol graph");
            findings.extend(graph.cycle_findings(max_findings));
        }
        if self.config.layers.dynamic_dead_code {
            let graph = graph.as_ref().expect("graph loaded for dead-code analysis");
            findings.extend(graph.dead_code_findings(&self.store, max_findings)?);
        }
        if self.config.layers.api_drift {
            let graph = graph.as_ref().expect("graph loaded for API drift analysis");
            findings.extend(graph.api_drift_findings(&self.store, max_findings)?);
        }
        if self.config.layers.session_conflicts {
            findings.extend(self.sessions.conflicts(
                session_id,
                self.config.thresholds.session_conflict_overlap,
                max_findings,
            ));
        }

        if let Some(filter) = path_filter {
            let filter_set = filter.iter().cloned().collect::<BTreeSet<_>>();
            findings.retain(|finding| finding_touches_paths(finding, &filter_set));
        }

        findings.sort_by(|left, right| {
            right
                .severity()
                .score()
                .cmp(&left.severity().score())
                .then_with(|| {
                    right
                        .confidence()
                        .partial_cmp(&left.confidence())
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then_with(|| left.stable_key().cmp(&right.stable_key()))
        });
        findings.dedup_by(|left, right| left.stable_key() == right.stable_key());
        findings.truncate(max_findings.saturating_mul(2));
        Ok(findings)
    }

    fn discover_source_files(&self) -> Result<Vec<String>> {
        let mut files = Vec::new();
        for entry in WalkDir::new(&self.project_root).follow_links(false) {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = normalize_rel(&self.project_root, entry.path());
            if self.should_ignore(&relative) || !is_code_file(&relative) {
                continue;
            }
            files.push(relative);
        }
        files.sort();
        files.dedup();
        Ok(files)
    }

    fn normalize_candidates(&self, files: Vec<String>) -> Vec<String> {
        let mut normalized = files
            .into_iter()
            .filter_map(|file| self.normalize_candidate_file(&file))
            .filter(|file| {
                !file.starts_with("../") && !self.should_ignore(file) && is_code_file(file)
            })
            .collect::<Vec<_>>();
        normalized.sort();
        normalized.dedup();
        normalized
    }

    fn normalize_candidate_file(&self, file: &str) -> Option<String> {
        let path = PathBuf::from(file);
        if path.is_absolute() {
            return path.strip_prefix(&self.project_root).ok().map(|relative| {
                normalize_rel(&self.project_root, &self.project_root.join(relative))
            });
        }
        Some(normalize_rel(
            &self.project_root,
            &self.project_root.join(path),
        ))
    }

    fn should_ignore(&self, relative_path: &str) -> bool {
        self.ignore.is_match(relative_path)
    }
}

#[derive(Debug)]
struct FocusAccumulator {
    severity: Severity,
    score: u32,
    reasons: BTreeSet<String>,
    evidence: Vec<Evidence>,
    finding_ids: BTreeSet<String>,
}

fn reverse_dependents_for(graph: &ModuleGraph, paths: &[String]) -> Vec<String> {
    let mut dependents = BTreeSet::new();
    let path_set = paths.iter().collect::<BTreeSet<_>>();
    for path in paths {
        for dependent in graph.reverse_dependents_of(path, 100) {
            if !path_set.contains(&dependent) {
                dependents.insert(dependent);
            }
        }
    }
    dependents.into_iter().collect()
}

fn findings_by_kind(findings: &[Finding], kind: &str) -> Vec<Finding> {
    findings
        .iter()
        .filter(|finding| finding_kind(finding) == kind)
        .cloned()
        .collect()
}

fn finding_kind(finding: &Finding) -> &'static str {
    match finding {
        Finding::SemanticClone { .. } => "semantic_clone",
        Finding::TypeShapeDuplicate { .. } => "type_shape_duplicate",
        Finding::ApiDrift { .. } => "api_drift",
        Finding::DeadCode { .. } => "dead_code",
        Finding::Cycle { .. } => "cycle",
        Finding::SessionConflict { .. } => "session_conflict",
    }
}

fn finding_files(findings: &[Finding], fallback: &BTreeSet<String>) -> Vec<String> {
    let mut files = BTreeSet::new();
    for finding in findings {
        match finding {
            Finding::SemanticClone {
                files: finding_files,
                ..
            } => {
                files.extend(finding_files.iter().cloned());
            }
            Finding::TypeShapeDuplicate { symbols, .. } => {
                for symbol in symbols {
                    if let Some((file, _)) = symbol.split_once("::") {
                        files.insert(file.to_string());
                    }
                }
            }
            Finding::ApiDrift {
                source_file,
                affected_callers,
                ..
            } => {
                files.insert(source_file.clone());
                files.extend(affected_callers.iter().cloned());
            }
            Finding::DeadCode { file, .. } => {
                files.insert(file.clone());
            }
            Finding::Cycle { nodes, .. } => {
                files.extend(nodes.iter().cloned());
            }
            Finding::SessionConflict { touched_cone, .. } => {
                files.extend(touched_cone.iter().cloned());
            }
        }
    }
    if files.is_empty() {
        files.extend(fallback.iter().take(12).cloned());
    }
    files.into_iter().take(12).collect()
}

fn highest_severity(findings: &[Finding]) -> Severity {
    findings
        .iter()
        .map(Finding::severity)
        .max()
        .unwrap_or(Severity::Info)
}

fn risk_level(score: u32) -> &'static str {
    if score >= 60 {
        "high"
    } else if score >= 25 {
        "medium"
    } else {
        "low"
    }
}

fn focus_from_reasons(reasons: &[ChangeRiskReason], limit: usize) -> Vec<ChangeRiskFocusItem> {
    let mut accumulators: BTreeMap<String, FocusAccumulator> = BTreeMap::new();
    for reason in reasons {
        for file in &reason.files {
            let entry = accumulators
                .entry(file.clone())
                .or_insert_with(|| FocusAccumulator {
                    severity: reason.severity,
                    score: 0,
                    reasons: BTreeSet::new(),
                    evidence: Vec::new(),
                    finding_ids: BTreeSet::new(),
                });
            if reason.severity > entry.severity {
                entry.severity = reason.severity;
            }
            entry.score = entry.score.saturating_add(reason.score);
            entry.reasons.insert(reason.kind.clone());
            entry.finding_ids.extend(reason.finding_ids.iter().cloned());
            if entry.evidence.len() < 4 {
                entry.evidence.push(Evidence {
                    kind: "graph_edge".into(),
                    file: Some(file.clone()),
                    symbol: None,
                    span: None,
                    detail: reason.detail.clone(),
                    score: Some(reason.score as f64),
                });
            }
        }
    }

    let mut focus = accumulators
        .into_iter()
        .map(|(target, accumulator)| ChangeRiskFocusItem {
            target,
            target_kind: "file".into(),
            severity: accumulator.severity,
            confidence: (0.5 + (f64::from(accumulator.score.min(50)) / 100.0)).min(0.99),
            score: accumulator.score.min(100),
            reasons: accumulator.reasons.into_iter().collect(),
            evidence: accumulator.evidence,
            finding_ids: accumulator.finding_ids.into_iter().collect(),
        })
        .collect::<Vec<_>>();
    focus.sort_by(|left, right| {
        right
            .severity
            .score()
            .cmp(&left.severity.score())
            .then_with(|| right.score.cmp(&left.score))
            .then_with(|| left.target.cmp(&right.target))
    });
    focus.truncate(limit);
    focus
}

fn syntax_probe(path: &Path, source: &str) -> Option<String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).unwrap_or_default();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if parsed.errors.is_empty() {
        None
    } else {
        Some(
            parsed
                .errors
                .iter()
                .take(3)
                .map(|error| error.to_string())
                .collect::<Vec<_>>()
                .join("; "),
        )
    }
}

fn maintenance_owner(kind: &str) -> String {
    format!("codemem-{kind}-{}", std::process::id())
}

fn extract_imports(project_root: &Path, from_path: &str, source: &str) -> Vec<ImportEdge> {
    let import_re =
        Regex::new(r#"(?m)^\s*import\s+(type\s+)?(?:[^\n'"]+?\s+from\s+)?['\"]([^'\"]+)['\"]"#)
            .unwrap();
    let reexport_re =
        Regex::new(r#"(?m)^\s*export\s+(?:\*|\{[^\n]+\})\s+from\s+['\"]([^'\"]+)['\"]"#).unwrap();
    let dynamic_re = Regex::new(r#"import\(\s*['\"]([^'\"]+)['\"]\s*\)"#).unwrap();

    let mut edges = Vec::new();
    for captures in import_re.captures_iter(source) {
        let specifier = captures.get(2).map(|m| m.as_str()).unwrap_or("");
        let offset = captures.get(0).map(|m| m.start()).unwrap_or(0);
        edges.push(ImportEdge {
            from_path: from_path.to_string(),
            specifier: specifier.to_string(),
            to_path: resolve_specifier(project_root, from_path, specifier),
            is_dynamic: false,
            is_type_only: captures.get(1).is_some(),
            line: byte_offset_to_line(source, offset),
        });
    }
    for captures in reexport_re.captures_iter(source) {
        let specifier = captures.get(1).map(|m| m.as_str()).unwrap_or("");
        let offset = captures.get(0).map(|m| m.start()).unwrap_or(0);
        edges.push(ImportEdge {
            from_path: from_path.to_string(),
            specifier: specifier.to_string(),
            to_path: resolve_specifier(project_root, from_path, specifier),
            is_dynamic: false,
            is_type_only: false,
            line: byte_offset_to_line(source, offset),
        });
    }
    for captures in dynamic_re.captures_iter(source) {
        let specifier = captures.get(1).map(|m| m.as_str()).unwrap_or("");
        let offset = captures.get(0).map(|m| m.start()).unwrap_or(0);
        edges.push(ImportEdge {
            from_path: from_path.to_string(),
            specifier: specifier.to_string(),
            to_path: resolve_specifier(project_root, from_path, specifier),
            is_dynamic: true,
            is_type_only: false,
            line: byte_offset_to_line(source, offset),
        });
    }
    edges
}

fn extract_exports(from_path: &str, source: &str) -> Vec<PublicApiSymbol> {
    let function_re = Regex::new(
        r"(?m)^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)",
    )
    .unwrap();
    let value_re = Regex::new(
        r"(?m)^\s*export\s+(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)(?::\s*([^=\n]+))?\s*=",
    )
    .unwrap();
    let class_re = Regex::new(r"(?m)^\s*export\s+class\s+([A-Za-z_][A-Za-z0-9_]*)").unwrap();
    let interface_re =
        Regex::new(r"(?m)^\s*export\s+interface\s+([A-Za-z_][A-Za-z0-9_]*)").unwrap();
    let type_re =
        Regex::new(r"(?m)^\s*export\s+type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n]+)").unwrap();
    let named_re = Regex::new(r"(?m)^\s*export\s*\{([^}]+)\}").unwrap();

    let mut exports = Vec::new();
    for captures in function_re.captures_iter(source) {
        let name = captures.get(1).map(|m| m.as_str()).unwrap_or("default");
        let params = captures.get(2).map(|m| m.as_str()).unwrap_or("");
        exports.push(PublicApiSymbol {
            export_name: name.to_string(),
            source_file: from_path.to_string(),
            signature: format!("fn({})", normalize_signature_params(params).join(",")),
        });
    }
    for captures in value_re.captures_iter(source) {
        let name = captures.get(1).map(|m| m.as_str()).unwrap_or("value");
        let annotation = captures
            .get(2)
            .map(|m| normalize_type_signature(m.as_str()));
        exports.push(PublicApiSymbol {
            export_name: name.to_string(),
            source_file: from_path.to_string(),
            signature: format!("value:{}", annotation.unwrap_or_else(|| "unknown".into())),
        });
    }
    for captures in class_re.captures_iter(source) {
        let name = captures.get(1).map(|m| m.as_str()).unwrap_or("Class");
        exports.push(PublicApiSymbol {
            export_name: name.to_string(),
            source_file: from_path.to_string(),
            signature: "class".into(),
        });
    }
    for captures in interface_re.captures_iter(source) {
        let name = captures.get(1).map(|m| m.as_str()).unwrap_or("Type");
        exports.push(PublicApiSymbol {
            export_name: name.to_string(),
            source_file: from_path.to_string(),
            signature: "interface".into(),
        });
    }
    for captures in type_re.captures_iter(source) {
        let name = captures.get(1).map(|m| m.as_str()).unwrap_or("Type");
        let rhs = captures
            .get(2)
            .map(|m| normalize_type_signature(m.as_str()))
            .unwrap_or_else(|| "unknown".into());
        exports.push(PublicApiSymbol {
            export_name: name.to_string(),
            source_file: from_path.to_string(),
            signature: format!("type:{rhs}"),
        });
    }
    for captures in named_re.captures_iter(source) {
        let members = captures.get(1).map(|m| m.as_str()).unwrap_or("");
        for member in members.split(',') {
            let member = member.trim();
            if member.is_empty() {
                continue;
            }
            let export_name = member
                .split_whitespace()
                .last()
                .unwrap_or(member)
                .to_string();
            exports.push(PublicApiSymbol {
                export_name,
                source_file: from_path.to_string(),
                signature: "reexport".into(),
            });
        }
    }

    let mut by_name = BTreeMap::new();
    for export in exports {
        by_name.insert(export.export_name.clone(), export);
    }
    by_name.into_values().collect()
}

fn resolve_specifier(project_root: &Path, from_path: &str, specifier: &str) -> Option<String> {
    if !(specifier.starts_with("./") || specifier.starts_with("../")) {
        return None;
    }
    let from_dir = Path::new(from_path)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let base = project_root.join(from_dir).join(specifier);
    let candidates = vec![
        base.clone(),
        base.with_extension("ts"),
        base.with_extension("tsx"),
        base.with_extension("js"),
        base.with_extension("jsx"),
        base.with_extension("mts"),
        base.with_extension("cts"),
        base.join("index.ts"),
        base.join("index.tsx"),
        base.join("index.js"),
        base.join("index.jsx"),
    ];
    for candidate in candidates {
        if candidate.is_file() {
            return Some(normalize_rel(project_root, &candidate));
        }
    }
    None
}

fn byte_offset_to_line(source: &str, offset: usize) -> u32 {
    (source[..offset.min(source.len())]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count()
        + 1) as u32
}

fn normalize_signature_params(params: &str) -> Vec<String> {
    params
        .split(',')
        .filter_map(|part| {
            let part = part.trim();
            if part.is_empty() {
                return None;
            }
            Some(
                part.split(':')
                    .nth(1)
                    .map(normalize_type_signature)
                    .unwrap_or_else(|| "unknown".into()),
            )
        })
        .collect()
}

fn normalize_type_signature(input: &str) -> String {
    let identifier = Regex::new(r"\b[A-Za-z_][A-Za-z0-9_]*\b").unwrap();
    let builtins = [
        "string",
        "number",
        "boolean",
        "unknown",
        "any",
        "never",
        "void",
        "null",
        "undefined",
        "object",
        "promise",
        "array",
        "readonlyarray",
        "record",
        "map",
        "set",
        "date",
        "bigint",
        "symbol",
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    let mut normalized = input.replace('\n', " ").replace('\t', " ");
    while normalized.contains("  ") {
        normalized = normalized.replace("  ", " ");
    }
    identifier
        .replace_all(&normalized, |captures: &regex::Captures<'_>| {
            let token = captures.get(0).map(|m| m.as_str()).unwrap_or("T");
            let lower = token.to_ascii_lowercase();
            if builtins.contains(&lower.as_str()) {
                lower
            } else {
                "T".to_string()
            }
        })
        .to_string()
        .replace(' ', "")
}

fn looks_generated(source: &str) -> bool {
    source.lines().take(8).any(|line| {
        line.contains("@generated") || line.contains("Generated by") || line.contains("DO NOT EDIT")
    })
}

fn is_code_file(relative_path: &str) -> bool {
    matches!(
        Path::new(relative_path)
            .extension()
            .and_then(|ext| ext.to_str()),
        Some("ts" | "tsx" | "js" | "jsx" | "mts" | "cts")
    )
}

fn finding_touches_paths(finding: &Finding, path_filter: &BTreeSet<String>) -> bool {
    match finding {
        Finding::SemanticClone { files, .. } => files.iter().any(|file| path_filter.contains(file)),
        Finding::TypeShapeDuplicate { symbols, .. } => symbols.iter().any(|symbol| {
            path_filter
                .iter()
                .any(|file| symbol.starts_with(&format!("{file}::")))
        }),
        Finding::ApiDrift {
            source_file,
            affected_callers,
            ..
        } => {
            path_filter.contains(source_file)
                || affected_callers
                    .iter()
                    .any(|caller| path_filter.contains(caller))
        }
        Finding::DeadCode { file, .. } => path_filter.contains(file),
        Finding::Cycle { nodes, .. } => nodes.iter().any(|node| path_filter.contains(node)),
        Finding::SessionConflict { touched_cone, .. } => {
            touched_cone.iter().any(|file| path_filter.contains(file))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Indexer;
    use crate::{
        config::{Layers, PackageBoundary, ProjectConfig},
        model::{CloneFingerprint, FileDocument, ImportEdge, PublicApiSymbol, TypeShapeRecord},
        protocol::FleetCorrelation,
        session_conflicts::SessionConflictTracker,
        store::Store,
    };
    use std::{
        fs,
        path::PathBuf,
        sync::Arc,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn disabled_layers_suppress_all_findings() {
        let project_root = temp_dir("project");
        let state_dir = temp_dir("state");
        fs::create_dir_all(&project_root).expect("create project root");
        fs::create_dir_all(&state_dir).expect("create state dir");
        let store = Arc::new(Store::open(&state_dir).expect("open store"));
        seed_findings_fixture(&store);

        let mut config = ProjectConfig::default();
        config.layers = Layers {
            ast_clones: false,
            simhash_clones: false,
            type_shapes: false,
            symbol_graph: false,
            api_drift: false,
            session_conflicts: false,
            dynamic_dead_code: false,
        };
        let config = Arc::new(config);
        let sessions = Arc::new(SessionConflictTracker::new(
            config.thresholds.session_conflict_decay_ms,
            Arc::clone(&store),
        ));
        let indexer = Indexer::new(
            project_root.clone(),
            state_dir,
            Arc::clone(&config),
            Arc::clone(&store),
            sessions,
        )
        .expect("create indexer");

        let findings = indexer
            .collect_findings(None, None, 50)
            .expect("collect findings");

        assert!(
            findings.is_empty(),
            "disabled layers produced findings: {findings:?}"
        );
    }

    #[tokio::test]
    async fn start_does_not_run_uncapped_bootstrap_scan() {
        let project_root = temp_dir("startup-project");
        let state_dir = temp_dir("startup-state");
        fs::create_dir_all(project_root.join("src")).expect("create fixture src");
        fs::create_dir_all(&state_dir).expect("create state dir");
        fs::write(project_root.join("src/index.ts"), "export const value = 1;\n")
            .expect("write source");
        let store = Arc::new(Store::open(&state_dir).expect("open store"));
        let config = Arc::new(ProjectConfig::default());
        let sessions = Arc::new(SessionConflictTracker::new(
            config.thresholds.session_conflict_decay_ms,
            Arc::clone(&store),
        ));
        let indexer = Indexer::new(
            project_root,
            state_dir,
            Arc::clone(&config),
            Arc::clone(&store),
            sessions,
        )
        .expect("create indexer");

        indexer.start();
        tokio::time::sleep(Duration::from_millis(250)).await;

        assert_eq!(store.stats().expect("store stats").indexed_files, 0);
    }

    #[tokio::test]
    async fn enqueue_files_does_not_block_when_queue_is_full() {
        let project_root = temp_dir("queue-project");
        let state_dir = temp_dir("queue-state");
        fs::create_dir_all(project_root.join("src")).expect("create fixture src");
        fs::create_dir_all(&state_dir).expect("create state dir");
        let store = Arc::new(Store::open(&state_dir).expect("open store"));
        let config = Arc::new(ProjectConfig::default());
        let sessions = Arc::new(SessionConflictTracker::new(
            config.thresholds.session_conflict_decay_ms,
            Arc::clone(&store),
        ));
        let indexer = Indexer::new(
            project_root,
            state_dir,
            Arc::clone(&config),
            Arc::clone(&store),
            sessions,
        )
        .expect("create indexer");

        for index in 0..300 {
            let result = tokio::time::timeout(
                Duration::from_millis(100),
                indexer.enqueue_files(
                    format!("session-{index}"),
                    vec![format!("src/file-{index}.ts")],
                    "event".into(),
                    FleetCorrelation::default(),
                ),
            )
            .await;

            assert!(result.is_ok(), "enqueue blocked at item {index}");
        }
        assert!(indexer.dropped_batches() > 0);
    }

    #[test]
    fn seeded_eval_findings_match_golden_and_performance_budget() {
        let project_root = temp_dir("project");
        let state_dir = temp_dir("state");
        fs::create_dir_all(&project_root).expect("create project root");
        fs::create_dir_all(&state_dir).expect("create state dir");
        let store = Arc::new(Store::open(&state_dir).expect("open store"));
        seed_findings_fixture(&store);
        let config = Arc::new(ProjectConfig::default());
        let sessions = Arc::new(SessionConflictTracker::new(
            config.thresholds.session_conflict_decay_ms,
            Arc::clone(&store),
        ));
        let indexer = Indexer::new(
            project_root.clone(),
            state_dir,
            Arc::clone(&config),
            Arc::clone(&store),
            sessions,
        )
        .expect("create indexer");

        let started = Instant::now();
        let findings = indexer
            .collect_findings(None, None, 50)
            .expect("collect findings");
        let elapsed = started.elapsed();
        let stable_keys = findings
            .iter()
            .map(|finding| finding.stable_key())
            .collect::<Vec<_>>();

        assert_eq!(
            stable_keys,
            vec![
                "api:src/a.ts:doThing:fn(string)->number:fn(number)->number",
                "semantic:l1_ast:src/a.ts|src/a.ts::A|src/b.ts|src/b.ts::B",
                "cycle:false:src/a.ts|src/b.ts",
                "type:same-shape:src/a.ts::AShape|src/b.ts::BShape",
                "dead:src/a.ts:doThing",
                "dead:src/b.ts:doOther",
            ]
        );
        assert!(
            elapsed.as_millis() < 250,
            "golden fixture collection exceeded budget: {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn fixture_repo_supports_impact_api_and_layer_eval_surfaces() {
        let project_root = temp_dir("fixture-project");
        let state_dir = temp_dir("fixture-state");
        fs::create_dir_all(project_root.join("src")).expect("create fixture src");
        fs::create_dir_all(&state_dir).expect("create state dir");
        fs::write(
            project_root.join("src/a.ts"),
            include_str!("../fixtures/golden/src/a.ts"),
        )
        .expect("write fixture a");
        fs::write(
            project_root.join("src/b.ts"),
            include_str!("../fixtures/golden/src/b.ts"),
        )
        .expect("write fixture b");

        let store = Arc::new(Store::open(&state_dir).expect("open store"));
        let mut config = ProjectConfig::default();
        config.package_boundaries = vec![
            PackageBoundary {
                root: "src/a.ts".into(),
                name: Some("a".into()),
                kind: Some("fixture".into()),
            },
            PackageBoundary {
                root: "src/b.ts".into(),
                name: Some("b".into()),
                kind: Some("fixture".into()),
            },
        ];
        let config = Arc::new(config);
        let sessions = Arc::new(SessionConflictTracker::new(
            config.thresholds.session_conflict_decay_ms,
            Arc::clone(&store),
        ));
        let indexer = Indexer::new(
            project_root.clone(),
            state_dir,
            Arc::clone(&config),
            Arc::clone(&store),
            sessions,
        )
        .expect("create indexer");

        indexer
            .index_paths_now(
                "fixture-eval",
                vec!["src/a.ts".into(), "src/b.ts".into()],
                "fixture eval",
            )
            .await
            .expect("index fixture repo");

        let api_exports = indexer
            .api_surface(100)
            .expect("api surface")
            .exports
            .into_iter()
            .map(|export| export.export_name)
            .collect::<Vec<_>>();
        let impact = indexer.impact_cone("src/a.ts", 2).expect("impact cone");
        let dot_impact = indexer
            .impact_cone("./src/a.ts", 2)
            .expect("dot impact cone");
        let absolute_impact = indexer
            .impact_cone(
                project_root.join("src/a.ts").to_str().expect("utf8 path"),
                2,
            )
            .expect("absolute impact cone");
        let layers = indexer.layer_boundaries(50).expect("layer boundaries");
        let first_layer_cycle = indexer
            .layer_boundaries(1)
            .expect("limited layer boundaries");

        assert!(api_exports.contains(&"publicApi".into()));
        assert!(api_exports.contains(&"bValue".into()));
        assert_eq!(impact.files, vec!["src/a.ts", "src/b.ts"]);
        assert_eq!(dot_impact.files, impact.files);
        assert_eq!(absolute_impact.files, impact.files);
        assert_eq!(layers.cycles.len(), 1);
        assert_eq!(first_layer_cycle.cycles.len(), 1);
    }

    #[test]
    fn api_surface_enforces_store_level_limit() {
        let project_root = temp_dir("api-limit-project");
        let state_dir = temp_dir("api-limit-state");
        fs::create_dir_all(&project_root).expect("create project root");
        fs::create_dir_all(&state_dir).expect("create state dir");
        let store = Arc::new(Store::open(&state_dir).expect("open store"));
        for index in 0..3 {
            store
                .upsert_file_document(&fixture_document(
                    &format!("src/{index}.ts"),
                    "src/other.ts",
                    &format!("export{index}"),
                    "value:number",
                    &format!("Shape{index}"),
                ))
                .expect("upsert fixture document");
        }
        let config = Arc::new(ProjectConfig::default());
        let sessions = Arc::new(SessionConflictTracker::new(
            config.thresholds.session_conflict_decay_ms,
            Arc::clone(&store),
        ));
        let indexer = Indexer::new(
            project_root,
            state_dir,
            Arc::clone(&config),
            Arc::clone(&store),
            sessions,
        )
        .expect("create indexer");

        let surface = indexer.api_surface(2).expect("api surface");

        assert_eq!(surface.exports.len(), 2);
        assert_eq!(surface.total, 3);
        assert!(surface.truncated);
    }

    #[tokio::test]
    async fn change_risk_scores_shared_public_paths_above_isolated_paths() {
        let project_root = temp_dir("change-risk-project");
        let state_dir = temp_dir("change-risk-state");
        fs::create_dir_all(project_root.join("src")).expect("create fixture src");
        fs::create_dir_all(&state_dir).expect("create state dir");
        fs::write(
            project_root.join("src/a.ts"),
            include_str!("../fixtures/golden/src/a.ts"),
        )
        .expect("write fixture a");
        fs::write(
            project_root.join("src/b.ts"),
            include_str!("../fixtures/golden/src/b.ts"),
        )
        .expect("write fixture b");
        fs::write(
            project_root.join("src/c.ts"),
            "const localValue = 1;\nconsole.log(localValue);\n",
        )
        .expect("write fixture c");

        let store = Arc::new(Store::open(&state_dir).expect("open store"));
        let config = Arc::new(ProjectConfig::default());
        let sessions = Arc::new(SessionConflictTracker::new(
            config.thresholds.session_conflict_decay_ms,
            Arc::clone(&store),
        ));
        let indexer = Indexer::new(
            project_root,
            state_dir,
            Arc::clone(&config),
            Arc::clone(&store),
            sessions,
        )
        .expect("create indexer");

        indexer
            .index_paths_now(
                "fixture-eval",
                vec!["src/a.ts".into(), "src/b.ts".into(), "src/c.ts".into()],
                "fixture eval",
            )
            .await
            .expect("index fixture repo");

        let shared = indexer
            .change_risk(vec!["src/a.ts".into()], 2, None, 50)
            .expect("shared risk");
        let isolated = indexer
            .change_risk(vec!["src/c.ts".into()], 2, None, 50)
            .expect("isolated risk");

        assert!(shared.score > isolated.score);
        assert!(
            shared
                .reasons
                .iter()
                .any(|reason| reason.kind == "public_exports")
        );
        assert!(shared.reasons.iter().any(|reason| reason.kind == "cycles"));
        assert!(shared.focus.iter().any(|item| item.target == "src/a.ts"));
    }

    fn seed_findings_fixture(store: &Store) {
        store
            .write_api_baseline(
                &[PublicApiSymbol {
                    export_name: "doThing".into(),
                    source_file: "src/a.ts".into(),
                    signature: "fn(string)->number".into(),
                }],
                "baseline",
            )
            .expect("write api baseline");

        store
            .upsert_file_document(&fixture_document(
                "src/a.ts",
                "src/b.ts",
                "doThing",
                "fn(number)->number",
                "A",
            ))
            .expect("upsert a");
        store
            .upsert_file_document(&fixture_document(
                "src/b.ts",
                "src/a.ts",
                "doOther",
                "fn(number)->number",
                "B",
            ))
            .expect("upsert b");
    }

    fn fixture_document(
        path: &str,
        import_target: &str,
        export_name: &str,
        signature: &str,
        symbol: &str,
    ) -> FileDocument {
        FileDocument {
            path: path.into(),
            digest: format!("digest-{path}"),
            mtime_ms: 1,
            size_bytes: 100,
            generated: false,
            parse_error: None,
            imports: vec![ImportEdge {
                from_path: path.into(),
                specifier: "./peer".into(),
                to_path: Some(import_target.into()),
                is_dynamic: false,
                is_type_only: false,
                line: 1,
            }],
            exports: vec![PublicApiSymbol {
                export_name: export_name.into(),
                source_file: path.into(),
                signature: signature.into(),
            }],
            clones: vec![CloneFingerprint {
                file_path: path.into(),
                symbol: symbol.into(),
                kind: "function".into(),
                start_line: 1,
                end_line: 8,
                normalized_hash: "same-hash".into(),
                simhash: 123,
                token_count: 64,
                statement_count: 5,
                normalized_tokens: vec!["return".into(), "value".into()],
            }],
            type_shapes: vec![TypeShapeRecord {
                file_path: path.into(),
                symbol: format!("{symbol}Shape"),
                shape_hash: "same-shape".into(),
                fingerprint_json: r#"["id:string","name:string","age:number"]"#.into(),
                depth: 1,
                suppressed: false,
            }],
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "codemem-indexer-{name}-{}-{unique}",
            std::process::id()
        ))
    }
}
