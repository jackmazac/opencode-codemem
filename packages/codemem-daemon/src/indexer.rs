use crate::{
    config::{normalize_rel, ProjectConfig},
    detectors::{clones::CloneDetector, types::TypeShapeDetector},
    graph::ModuleGraph,
    model::{DriftMap, FileDocument, Finding, ImportEdge, PublicApiSymbol, StoreStats},
    session_conflicts::SessionConflictTracker,
    store::Store,
};
use anyhow::{Context, Result};
use blake3::hash;
use globset::GlobSet;
use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;
use parking_lot::Mutex;
use regex::Regex;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicI64, AtomicUsize, Ordering},
        Arc,
    },
    time::Instant,
};
use tokio::sync::mpsc;
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
                    let _ = this
                        .index_paths_now(&item.session_id, item.files.clone(), &item.reason)
                        .await;
                    this.queue_depth.fetch_sub(1, Ordering::SeqCst);
                }
            });
        }

        let this = Arc::clone(self);
        tokio::spawn(async move {
            let _ = this.bootstrap_scan().await;
        });
    }

    pub fn queue_depth(&self) -> usize {
        self.queue_depth.load(Ordering::SeqCst)
    }

    pub fn indexed_at_ms(&self) -> i64 {
        self.indexed_at_ms.load(Ordering::SeqCst)
    }

    pub fn store_stats(&self) -> Result<StoreStats> {
        self.store.stats()
    }

    pub async fn enqueue_files(&self, session_id: String, files: Vec<String>, reason: String) -> Result<()> {
        let files = self.normalize_candidates(files);
        if files.is_empty() {
            return Ok(());
        }
        self.queue_depth.fetch_add(1, Ordering::SeqCst);
        if let Err(error) = self
            .worker_tx
            .send(IndexWorkItem {
                session_id,
                files,
                reason,
            })
            .await
        {
            self.queue_depth.fetch_sub(1, Ordering::SeqCst);
            return Err(anyhow::anyhow!(error.to_string()));
        }
        Ok(())
    }

    pub async fn bootstrap_scan(&self) -> Result<()> {
        let files = self.discover_source_files()?;
        if files.is_empty() {
            return Ok(());
        }
        self.index_paths_now("bootstrap", files, "bootstrap").await?;
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
                self.index_paths_now(session_id.unwrap_or("manual"), paths, "manual").await?;
            }
        }

        let findings = self.collect_findings(normalized_paths.as_ref(), session_id, max_findings)?;
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
        let map = graph.drift_map(check.findings.clone()).finish(check.findings);
        Ok(DriftMapSummary {
            map,
            indexed_at_ms: self.indexed_at_ms(),
        })
    }

    pub async fn conflicts(&self, session_id: Option<&str>, max_findings: usize) -> Result<ConflictSummary> {
        let findings = self
            .sessions
            .conflicts(
                session_id,
                self.config.thresholds.session_conflict_overlap,
                max_findings,
            );
        Ok(ConflictSummary {
            findings,
            indexed_at_ms: self.indexed_at_ms(),
        })
    }

    pub fn maintain(&self, dry_run: bool, prune_logs: bool, compact: bool) -> Result<MaintainSummary> {
        let mut actions = Vec::new();
        let stale_sessions = self.sessions.stale_sessions();
        if !stale_sessions.is_empty() {
            actions.push(MaintainAction {
                kind: "stale_sessions".into(),
                detail: format!("{} stale sessions will be pruned by retention policy", stale_sessions.len()),
                estimated_bytes: None,
            });
        }
        if prune_logs {
            actions.push(MaintainAction {
                kind: "prune_logs".into(),
                detail: format!("prune local event logs older than {} days", self.config.telemetry.retain_days),
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
            return Ok(MaintainSummary { actions, applied: false });
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
        Ok(MaintainSummary { actions, applied: true })
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
        self.store.clear_index()?;
        self.indexed_at_ms.store(0, Ordering::SeqCst);
        self.bootstrap_scan().await?;
        Ok(RebuildSummary {
            would_rebuild: true,
            reason,
        })
    }

    async fn index_paths_now(&self, session_id: &str, files: Vec<String>, reason: &str) -> Result<usize> {
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
            let imports = extract_imports(&self.project_root, &relative_path, &source);
            let exports = extract_exports(&relative_path, &source);
            let clones = self
                .clone_detector
                .analyze_file(&relative_path, &source, generated);
            let type_shapes = self
                .type_shape_detector
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
            let graph = ModuleGraph::load(&self.project_root, &self.config, &self.store)?;
            if !touched_files.is_empty() {
                let _ = self.sessions.observe(session_id, touched_files.clone(), &graph);
            }
            let _ = graph.ensure_api_baseline(&self.store);
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
        let clone_records = self.store.load_clone_fingerprints()?;
        let type_records = self.store.load_type_shapes()?;
        findings.extend(self.clone_detector.detect(&clone_records, max_findings));
        findings.extend(self.type_shape_detector.detect(&type_records, max_findings));

        let graph = ModuleGraph::load(&self.project_root, &self.config, &self.store)?;
        findings.extend(graph.cycle_findings(max_findings));
        findings.extend(graph.dead_code_findings(&self.store, max_findings)?);
        findings.extend(graph.api_drift_findings(&self.store, max_findings)?);
        if self.config.layers.session_conflicts {
            findings.extend(
                self.sessions.conflicts(
                    session_id,
                    self.config.thresholds.session_conflict_overlap,
                    max_findings,
                ),
            );
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
                .then_with(|| right.confidence().partial_cmp(&left.confidence()).unwrap_or(std::cmp::Ordering::Equal))
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
            .map(|file| {
                let path = PathBuf::from(file);
                if path.is_absolute() {
                    normalize_rel(&self.project_root, &path)
                } else {
                    normalize_rel(&self.project_root, &self.project_root.join(path))
                }
            })
            .filter(|file| !file.starts_with("../") && !self.should_ignore(file) && is_code_file(file))
            .collect::<Vec<_>>();
        normalized.sort();
        normalized.dedup();
        normalized
    }

    fn should_ignore(&self, relative_path: &str) -> bool {
        self.ignore.is_match(relative_path)
    }
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

fn extract_imports(project_root: &Path, from_path: &str, source: &str) -> Vec<ImportEdge> {
    let import_re = Regex::new(
        r#"(?m)^\s*import\s+(type\s+)?(?:[^\n'"]+?\s+from\s+)?['\"]([^'\"]+)['\"]"#,
    )
    .unwrap();
    let reexport_re = Regex::new(
        r#"(?m)^\s*export\s+(?:\*|\{[^\n]+\})\s+from\s+['\"]([^'\"]+)['\"]"#,
    )
    .unwrap();
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
    let interface_re = Regex::new(r"(?m)^\s*export\s+interface\s+([A-Za-z_][A-Za-z0-9_]*)").unwrap();
    let type_re = Regex::new(r"(?m)^\s*export\s+type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n]+)").unwrap();
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
        let annotation = captures.get(2).map(|m| normalize_type_signature(m.as_str()));
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
        let rhs = captures.get(2).map(|m| normalize_type_signature(m.as_str())).unwrap_or_else(|| "unknown".into());
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
    let from_dir = Path::new(from_path).parent().unwrap_or_else(|| Path::new(""));
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
    (source[..offset.min(source.len())].bytes().filter(|byte| *byte == b'\n').count() + 1) as u32
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
        "string", "number", "boolean", "unknown", "any", "never", "void", "null", "undefined", "object",
        "promise", "array", "readonlyarray", "record", "map", "set", "date", "bigint", "symbol",
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
    source
        .lines()
        .take(8)
        .any(|line| line.contains("@generated") || line.contains("Generated by") || line.contains("DO NOT EDIT"))
}

fn is_code_file(relative_path: &str) -> bool {
    matches!(
        Path::new(relative_path).extension().and_then(|ext| ext.to_str()),
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
        Finding::ApiDrift { source_file, affected_callers, .. } => {
            path_filter.contains(source_file) || affected_callers.iter().any(|caller| path_filter.contains(caller))
        }
        Finding::DeadCode { file, .. } => path_filter.contains(file),
        Finding::Cycle { nodes, .. } => nodes.iter().any(|node| path_filter.contains(node)),
        Finding::SessionConflict { touched_cone, .. } => touched_cone.iter().any(|file| path_filter.contains(file)),
    }
}
