use chrono::Utc;
use parking_lot::Mutex;
use serde::Serialize;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Instant,
};

const MAX_SAMPLES_PER_OPERATION: usize = 512;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationMetricSummary {
    pub count: usize,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub max_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySnapshot {
    pub operations: BTreeMap<String, OperationMetricSummary>,
    pub counters: BTreeMap<String, usize>,
    pub captured_at_unix_ms: i64,
}

#[derive(Debug, Default)]
pub struct Metrics {
    durations: Mutex<BTreeMap<String, VecDeque<u64>>>,
    queue_drops: AtomicUsize,
    queue_depth: AtomicUsize,
    queue_failed: AtomicUsize,
    truncated_outputs: AtomicUsize,
    omitted_items: AtomicUsize,
}

impl Metrics {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn record_duration(&self, operation: impl Into<String>, started: Instant) {
        let elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        let mut durations = self.durations.lock();
        let samples = durations.entry(operation.into()).or_default();
        if samples.len() >= MAX_SAMPLES_PER_OPERATION {
            samples.pop_front();
        }
        samples.push_back(elapsed_ms);
    }

    pub fn set_queue_depth(&self, value: usize) {
        self.queue_depth.store(value, Ordering::SeqCst);
    }

    pub fn set_queue_failed(&self, value: usize) {
        self.queue_failed.store(value, Ordering::SeqCst);
    }

    pub fn increment_queue_drops(&self) {
        self.queue_drops.fetch_add(1, Ordering::SeqCst);
    }

    pub fn set_queue_drops(&self, value: usize) {
        self.queue_drops.store(value, Ordering::SeqCst);
    }

    pub fn record_truncation(&self, omitted: usize) {
        if omitted == 0 {
            return;
        }
        self.truncated_outputs.fetch_add(1, Ordering::SeqCst);
        self.omitted_items.fetch_add(omitted, Ordering::SeqCst);
    }

    pub fn snapshot(&self) -> TelemetrySnapshot {
        let operations = self
            .durations
            .lock()
            .iter()
            .map(|(name, samples)| (name.clone(), summarize(samples)))
            .collect::<BTreeMap<_, _>>();
        let mut counters = BTreeMap::new();
        counters.insert("queueDepth".into(), self.queue_depth.load(Ordering::SeqCst));
        counters.insert("queueDrops".into(), self.queue_drops.load(Ordering::SeqCst));
        counters.insert(
            "queueFailed".into(),
            self.queue_failed.load(Ordering::SeqCst),
        );
        counters.insert(
            "truncatedOutputs".into(),
            self.truncated_outputs.load(Ordering::SeqCst),
        );
        counters.insert(
            "omittedItems".into(),
            self.omitted_items.load(Ordering::SeqCst),
        );
        TelemetrySnapshot {
            operations,
            counters,
            captured_at_unix_ms: Utc::now().timestamp_millis(),
        }
    }
}

fn summarize(samples: &VecDeque<u64>) -> OperationMetricSummary {
    if samples.is_empty() {
        return OperationMetricSummary {
            count: 0,
            p50_ms: 0,
            p95_ms: 0,
            max_ms: 0,
        };
    }
    let mut sorted = samples.iter().copied().collect::<Vec<_>>();
    sorted.sort_unstable();
    let p50 = percentile(&sorted, 0.50);
    let p95 = percentile(&sorted, 0.95);
    let max = sorted.last().copied().unwrap_or_default();
    OperationMetricSummary {
        count: sorted.len(),
        p50_ms: p50,
        p95_ms: p95,
        max_ms: max,
    }
}

fn percentile(sorted: &[u64], percentile: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let index = ((sorted.len() - 1) as f64 * percentile).ceil() as usize;
    sorted[index.min(sorted.len() - 1)]
}
