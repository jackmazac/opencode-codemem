use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warn,
    Error,
}

impl Severity {
    pub fn score(self) -> u8 {
        match self {
            Self::Info => 0,
            Self::Warn => 1,
            Self::Error => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Evidence {
    pub kind: String,
    pub file: Option<String>,
    pub symbol: Option<String>,
    pub span: Option<Span>,
    pub detail: String,
    pub score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloneFingerprint {
    pub file_path: String,
    pub symbol: String,
    pub kind: String,
    pub start_line: u32,
    pub end_line: u32,
    pub normalized_hash: String,
    pub simhash: u64,
    pub token_count: usize,
    pub statement_count: usize,
    pub normalized_tokens: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeShapeRecord {
    pub file_path: String,
    pub symbol: String,
    pub shape_hash: String,
    pub fingerprint_json: String,
    pub depth: u8,
    pub suppressed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportEdge {
    pub from_path: String,
    pub specifier: String,
    pub to_path: Option<String>,
    pub is_dynamic: bool,
    pub is_type_only: bool,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicApiSymbol {
    pub export_name: String,
    pub source_file: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDocument {
    pub path: String,
    pub digest: String,
    pub mtime_ms: i64,
    pub size_bytes: u64,
    pub generated: bool,
    pub parse_error: Option<String>,
    pub imports: Vec<ImportEdge>,
    pub exports: Vec<PublicApiSymbol>,
    pub clones: Vec<CloneFingerprint>,
    pub type_shapes: Vec<TypeShapeRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub session_id: String,
    pub last_seen_ms: i64,
    pub status: String,
    pub touched_files: Vec<String>,
    pub touched_cone: Vec<String>,
    pub parent_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreStats {
    pub indexed_files: usize,
    pub clone_buckets: usize,
    pub type_buckets: usize,
    pub sessions_tracked: usize,
    pub findings_cache_entries: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriftMapNode {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub severity: Option<Severity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriftMapEdge {
    pub from: String,
    pub to: String,
    pub kind: String,
    pub dynamic: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriftMap {
    pub nodes: Vec<DriftMapNode>,
    pub edges: Vec<DriftMapEdge>,
    pub findings: Vec<Finding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Finding {
    SemanticClone {
        severity: Severity,
        confidence: f64,
        evidence: Vec<Evidence>,
        action: String,
        files: Vec<String>,
        symbols: Vec<String>,
        canonical_hash: Option<String>,
        detector: String,
        recommendation: String,
    },
    TypeShapeDuplicate {
        severity: Severity,
        confidence: f64,
        evidence: Vec<Evidence>,
        action: String,
        symbols: Vec<String>,
        shape_hash: String,
        recommendation: String,
    },
    ApiDrift {
        severity: Severity,
        confidence: f64,
        evidence: Vec<Evidence>,
        action: String,
        export_name: String,
        source_file: String,
        before: String,
        after: String,
        affected_callers: Vec<String>,
    },
    DeadCode {
        severity: Severity,
        confidence: f64,
        evidence: Vec<Evidence>,
        action: String,
        symbol: String,
        file: String,
        reason: String,
        dynamic_import_risk: bool,
    },
    Cycle {
        severity: Severity,
        confidence: f64,
        evidence: Vec<Evidence>,
        action: String,
        nodes: Vec<String>,
        package_level: bool,
    },
    SessionConflict {
        severity: Severity,
        confidence: f64,
        evidence: Vec<Evidence>,
        action: String,
        sessions: Vec<String>,
        touched_cone: Vec<String>,
    },
}

impl Finding {
    pub fn severity(&self) -> Severity {
        match self {
            Self::SemanticClone { severity, .. }
            | Self::TypeShapeDuplicate { severity, .. }
            | Self::ApiDrift { severity, .. }
            | Self::DeadCode { severity, .. }
            | Self::Cycle { severity, .. }
            | Self::SessionConflict { severity, .. } => *severity,
        }
    }

    pub fn confidence(&self) -> f64 {
        match self {
            Self::SemanticClone { confidence, .. }
            | Self::TypeShapeDuplicate { confidence, .. }
            | Self::ApiDrift { confidence, .. }
            | Self::DeadCode { confidence, .. }
            | Self::Cycle { confidence, .. }
            | Self::SessionConflict { confidence, .. } => *confidence,
        }
    }

    pub fn stable_key(&self) -> String {
        match self {
            Self::SemanticClone { files, symbols, detector, .. } => {
                format!("semantic:{}:{}", detector, pair_key(files, symbols))
            }
            Self::TypeShapeDuplicate { shape_hash, symbols, .. } => {
                format!("type:{}:{}", shape_hash, symbols.join("|"))
            }
            Self::ApiDrift { export_name, source_file, before, after, .. } => {
                format!("api:{}:{}:{}:{}", source_file, export_name, before, after)
            }
            Self::DeadCode { file, symbol, .. } => format!("dead:{}:{}", file, symbol),
            Self::Cycle { nodes, package_level, .. } => {
                format!("cycle:{}:{}", package_level, nodes.join("|"))
            }
            Self::SessionConflict { sessions, touched_cone, .. } => {
                format!("session:{}:{}", sessions.join("|"), touched_cone.join("|"))
            }
        }
    }
}

fn pair_key(left: &[String], right: &[String]) -> String {
    let mut all = left.to_vec();
    all.extend(right.iter().cloned());
    all.sort();
    all.join("|")
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DriftMapAssembly {
    pub nodes: BTreeMap<String, DriftMapNode>,
    pub edges: BTreeSet<(String, String, String, bool)>,
}

impl DriftMapAssembly {
    pub fn insert_node(&mut self, node: DriftMapNode) {
        self.nodes.insert(node.id.clone(), node);
    }

    pub fn insert_edge(&mut self, from: String, to: String, kind: String, dynamic: bool) {
        self.edges.insert((from, to, kind, dynamic));
    }

    pub fn finish(self, findings: Vec<Finding>) -> DriftMap {
        let edges = self
            .edges
            .into_iter()
            .map(|(from, to, kind, dynamic)| DriftMapEdge {
                from,
                to,
                kind,
                dynamic,
            })
            .collect();
        DriftMap {
            nodes: self.nodes.into_values().collect(),
            edges,
            findings,
        }
    }
}
