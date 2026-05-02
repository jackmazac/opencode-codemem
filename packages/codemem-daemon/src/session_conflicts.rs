use crate::{
    graph::ModuleGraph,
    model::{Evidence, Finding, SessionSnapshot, Severity},
    store::Store,
};
use anyhow::Result;
use chrono::Utc;
use parking_lot::Mutex;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub struct SessionConflictTracker {
    decay_ms: i64,
    store: Arc<Store>,
    sessions: Mutex<BTreeMap<String, SessionSnapshot>>,
}

impl SessionConflictTracker {
    pub fn new(decay_ms: i64, store: Arc<Store>) -> Self {
        let initial = store
            .load_sessions()
            .unwrap_or_default()
            .into_iter()
            .map(|session| (session.session_id.clone(), session))
            .collect();
        Self {
            decay_ms,
            store,
            sessions: Mutex::new(initial),
        }
    }

    pub fn observe(
        &self,
        session_id: &str,
        touched_files: Vec<String>,
        graph: &ModuleGraph,
    ) -> Result<()> {
        if session_id.trim().is_empty() {
            return Ok(());
        }
        let now = Utc::now().timestamp_millis();
        let cone = graph
            .dependency_cone(&touched_files, 2)
            .into_iter()
            .collect::<Vec<_>>();
        let snapshot = SessionSnapshot {
            session_id: session_id.to_string(),
            last_seen_ms: now,
            status: "active".into(),
            touched_files,
            touched_cone: cone,
            parent_session_id: None,
        };
        self.sessions
            .lock()
            .insert(snapshot.session_id.clone(), snapshot.clone());
        self.store.upsert_session(&snapshot)?;
        Ok(())
    }

    pub fn stale_sessions(&self) -> Vec<String> {
        let now = Utc::now().timestamp_millis();
        self.sessions
            .lock()
            .values()
            .filter(|snapshot| now - snapshot.last_seen_ms > self.decay_ms)
            .map(|snapshot| snapshot.session_id.clone())
            .collect()
    }

    pub fn conflicts(
        &self,
        session_filter: Option<&str>,
        overlap_threshold: f64,
        max_findings: usize,
    ) -> Vec<Finding> {
        let snapshots = self.active_snapshots();
        let filtered = if let Some(session_id) = session_filter {
            let mut keep = Vec::new();
            for snapshot in &snapshots {
                if snapshot.session_id == session_id {
                    keep.push(snapshot.clone());
                    keep.extend(
                        snapshots
                            .iter()
                            .filter(|other| other.session_id != session_id)
                            .cloned(),
                    );
                    break;
                }
            }
            keep
        } else {
            snapshots
        };

        let mut findings = Vec::new();
        let mut seen = BTreeSet::new();
        for left_index in 0..filtered.len() {
            for right_index in (left_index + 1)..filtered.len() {
                let left = &filtered[left_index];
                let right = &filtered[right_index];
                let key = if left.session_id <= right.session_id {
                    format!("{}::{}", left.session_id, right.session_id)
                } else {
                    format!("{}::{}", right.session_id, left.session_id)
                };
                if !seen.insert(key) {
                    continue;
                }

                let left_set = left.touched_cone.iter().collect::<BTreeSet<_>>();
                let right_set = right.touched_cone.iter().collect::<BTreeSet<_>>();
                let overlap = left_set
                    .intersection(&right_set)
                    .map(|item| (*item).clone())
                    .collect::<Vec<_>>();
                if overlap.is_empty() {
                    continue;
                }
                let min_size = left_set.len().min(right_set.len()).max(1) as f64;
                let coefficient = overlap.len() as f64 / min_size;
                if coefficient < overlap_threshold {
                    continue;
                }
                let direct_touch = left
                    .touched_files
                    .iter()
                    .any(|file| right.touched_files.iter().any(|other| other == file));
                let severity = if direct_touch {
                    Severity::Error
                } else {
                    Severity::Warn
                };
                findings.push(Finding::SessionConflict {
                    severity,
                    confidence: coefficient.min(0.99),
                    evidence: vec![
                        Evidence {
                            kind: "session_overlap".into(),
                            file: None,
                            symbol: None,
                            span: None,
                            detail: format!(
                                "dependency-cone overlap {:.2} between sessions {} and {}",
                                coefficient, left.session_id, right.session_id
                            ),
                            score: Some(coefficient),
                        },
                        Evidence {
                            kind: "session_overlap".into(),
                            file: overlap.first().cloned(),
                            symbol: None,
                            span: None,
                            detail: format!(
                                "{} overlapping files in cones; directTouch={direct_touch}",
                                overlap.len()
                            ),
                            score: Some(coefficient),
                        },
                    ],
                    action: "Coordinate ownership before applying edits, or narrow both sessions to disjoint subgraphs.".into(),
                    sessions: vec![left.session_id.clone(), right.session_id.clone()],
                    touched_cone: overlap.into_iter().take(12).collect(),
                });
                if findings.len() >= max_findings {
                    return findings;
                }
            }
        }
        findings
    }

    fn active_snapshots(&self) -> Vec<SessionSnapshot> {
        let now = Utc::now().timestamp_millis();
        self.sessions
            .lock()
            .values()
            .filter(|snapshot| now - snapshot.last_seen_ms <= self.decay_ms)
            .cloned()
            .collect()
    }
}
