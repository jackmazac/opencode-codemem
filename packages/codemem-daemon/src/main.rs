mod config;
mod detectors;
mod graph;
mod indexer;
mod model;
mod rpc;
mod session_conflicts;
mod store;

use crate::{
    config::load_project_config,
    indexer::Indexer,
    rpc::{RpcContext, serve},
    session_conflicts::SessionConflictTracker,
    store::Store,
};
use anyhow::{Context, Result};
use chrono::Utc;
use std::{env, fs, path::PathBuf, sync::Arc};

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    let project_root = required_path_env("CODEMEM_PROJECT_ROOT")?;
    let state_dir =
        optional_path_env("CODEMEM_STATE_DIR").unwrap_or_else(|| project_root.join(".codemem"));
    let endpoint = env::var("CODEMEM_ENDPOINT").context("CODEMEM_ENDPOINT is required")?;
    let auth_token = env::var("CODEMEM_AUTH_TOKEN").ok();
    let protocol_version = env::var("CODEMEM_PROTOCOL_VERSION")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(1);

    fs::create_dir_all(&state_dir)
        .with_context(|| format!("failed to create state directory {}", state_dir.display()))?;
    fs::create_dir_all(state_dir.join("run"))?;
    fs::create_dir_all(state_dir.join("log"))?;

    let config = Arc::new(load_project_config(&project_root)?);
    let store = Arc::new(Store::open(&state_dir)?);
    let sessions = Arc::new(SessionConflictTracker::new(
        config.thresholds.session_conflict_decay_ms,
        Arc::clone(&store),
    ));
    let indexer = Indexer::new(
        project_root.clone(),
        state_dir.clone(),
        Arc::clone(&config),
        Arc::clone(&store),
        Arc::clone(&sessions),
    )?;
    indexer.start();

    store.append_event(
        "daemon.started",
        &serde_json::json!({
            "projectRoot": project_root,
            "stateDirectory": state_dir,
            "protocolVersion": protocol_version,
            "daemonVersion": rpc::DAEMON_VERSION,
            "startedAtUnixMs": Utc::now().timestamp_millis(),
        }),
    )?;

    let ctx = Arc::new(RpcContext {
        protocol_version,
        auth_token,
        endpoint,
        project_root,
        state_dir,
        config,
        indexer,
        started_at_unix_ms: Utc::now().timestamp_millis(),
    });

    serve(ctx).await
}

fn required_path_env(key: &str) -> Result<PathBuf> {
    let value = env::var(key).with_context(|| format!("{key} is required"))?;
    Ok(PathBuf::from(value))
}

fn optional_path_env(key: &str) -> Option<PathBuf> {
    env::var(key).ok().map(PathBuf::from)
}
