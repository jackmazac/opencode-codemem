use crate::{
    config::ProjectConfig,
    indexer::{
        ApiSurfaceSummary, ChangeRiskSummary, CheckSummary, ConflictSummary, DriftMapSummary,
        ImpactConeSummary, Indexer, LayerBoundarySummary, LockfileSummary, MaintainSummary,
        RebuildSummary,
    },
    model::{DriftMap, Evidence, Finding, Severity, StoreStats},
    protocol::FleetCorrelation,
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::Notify,
};

pub const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const SCHEMA_VERSION: u32 = 1;

pub struct RpcContext {
    pub protocol_version: u32,
    pub auth_token: Option<String>,
    pub endpoint: String,
    pub project_root: PathBuf,
    pub state_dir: PathBuf,
    pub config: Arc<ProjectConfig>,
    pub indexer: Arc<Indexer>,
    pub started_at_unix_ms: i64,
    pub shutdown: Arc<Notify>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestEnvelope {
    jsonrpc: String,
    protocol_version: u32,
    id: Option<String>,
    auth_token: Option<String>,
    method: String,
    params: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResponseEnvelope {
    jsonrpc: &'static str,
    protocol_version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorEnvelope>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEnvelope {
    code: String,
    message: String,
    retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthParams {
    project_root: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FilesChangedParams {
    project_root: String,
    #[serde(rename = "sessionID")]
    session_id: String,
    files: Vec<String>,
    reason: String,
    #[serde(rename = "turnID")]
    turn_id: Option<String>,
    observed_at_unix_ms: i64,
    #[serde(default, flatten)]
    correlation: FleetCorrelation,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckParams {
    project_root: String,
    #[serde(rename = "sessionID")]
    session_id: Option<String>,
    paths: Option<Vec<String>>,
    max_findings: usize,
    include_evidence: bool,
    wait_for_fresh_index: bool,
    #[serde(default, flatten)]
    correlation: FleetCorrelation,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DriftMapParams {
    project_root: String,
    #[serde(rename = "sessionID")]
    session_id: Option<String>,
    max_findings: usize,
    #[serde(default, flatten)]
    correlation: FleetCorrelation,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictsParams {
    project_root: String,
    #[serde(rename = "sessionID")]
    session_id: Option<String>,
    #[serde(default, flatten)]
    correlation: FleetCorrelation,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImpactConeParams {
    project_root: String,
    path: String,
    depth: usize,
    #[serde(default, flatten)]
    correlation: FleetCorrelation,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangeRiskParams {
    project_root: String,
    paths: Vec<String>,
    depth: usize,
    max_findings: usize,
    #[serde(rename = "sessionID")]
    session_id: Option<String>,
    #[serde(default, flatten)]
    correlation: FleetCorrelation,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiSurfaceParams {
    project_root: String,
    max_exports: usize,
    #[serde(default, flatten)]
    correlation: FleetCorrelation,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LayerBoundariesParams {
    project_root: String,
    max_findings: usize,
    #[serde(default, flatten)]
    correlation: FleetCorrelation,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockfileParams {
    project_root: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaintainParams {
    project_root: String,
    dry_run: bool,
    prune_logs: Option<bool>,
    compact: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RebuildParams {
    project_root: String,
    dry_run: bool,
}

pub async fn serve(ctx: Arc<RpcContext>) -> Result<()> {
    #[cfg(unix)]
    {
        return serve_unix(ctx).await;
    }
    #[cfg(windows)]
    {
        return serve_windows(ctx).await;
    }
    #[allow(unreachable_code)]
    Err(anyhow::anyhow!(
        "unsupported platform for codemem local RPC"
    ))
}

#[cfg(unix)]
async fn serve_unix(ctx: Arc<RpcContext>) -> Result<()> {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    if let Some(parent) = PathBuf::from(&ctx.endpoint).parent() {
        fs::create_dir_all(parent)?;
    }
    let _ = fs::remove_file(&ctx.endpoint);
    let listener = UnixListener::bind(&ctx.endpoint)
        .with_context(|| format!("failed to bind unix socket {}", ctx.endpoint))?;
    fs::set_permissions(&ctx.endpoint, fs::Permissions::from_mode(0o600))?;

    loop {
        let (stream, _) = listener.accept().await?;
        let ctx = Arc::clone(&ctx);
        tokio::spawn(async move {
            let _ = handle_stream(stream, ctx).await;
        });
    }
}

#[cfg(windows)]
async fn serve_windows(ctx: Arc<RpcContext>) -> Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;

    let name = ctx.endpoint.clone();
    let mut server = ServerOptions::new().create(&name)?;
    loop {
        server.connect().await?;
        let next = ServerOptions::new().create(&name)?;
        let connected = server;
        let ctx = Arc::clone(&ctx);
        tokio::spawn(async move {
            let _ = handle_stream(connected, ctx).await;
        });
        server = next;
    }
}

async fn handle_stream<S>(mut stream: S, ctx: Arc<RpcContext>) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    loop {
        let request = match read_frame(&mut stream, 4 * 1024 * 1024).await {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return Ok(()),
            Err(error) => {
                let response = response_error(
                    None,
                    ctx.protocol_version,
                    "invalid_frame",
                    &error.to_string(),
                    true,
                    None,
                );
                let _ = write_response(&mut stream, &response).await;
                return Err(error);
            }
        };

        let envelope: RequestEnvelope = match serde_json::from_slice(&request) {
            Ok(envelope) => envelope,
            Err(error) => {
                let response = response_error(
                    None,
                    ctx.protocol_version,
                    "invalid_json",
                    &error.to_string(),
                    false,
                    None,
                );
                write_response(&mut stream, &response).await?;
                continue;
            }
        };

        if envelope.id.is_none() {
            let _ = dispatch(&ctx, envelope).await;
            continue;
        }
        let response = dispatch(&ctx, envelope).await;
        write_response(&mut stream, &response).await?;
    }
}

async fn read_frame<S>(stream: &mut S, max_payload_bytes: usize) -> Result<Option<Vec<u8>>>
where
    S: AsyncRead + Unpin,
{
    let mut length_prefix = [0u8; 4];
    match stream.read_exact(&mut length_prefix).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let length = u32::from_be_bytes(length_prefix) as usize;
    if length > max_payload_bytes.max(4 * 1024 * 1024) {
        return Err(anyhow::anyhow!(
            "frame exceeds codemem limit ({length} bytes)"
        ));
    }
    let mut payload = vec![0u8; length];
    stream.read_exact(&mut payload).await?;
    Ok(Some(payload))
}

async fn write_response<S>(stream: &mut S, response: &ResponseEnvelope) -> Result<()>
where
    S: AsyncWrite + Unpin,
{
    let payload = serde_json::to_vec(response)?;
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    stream.write_all(&frame).await?;
    stream.flush().await?;
    Ok(())
}

async fn dispatch(ctx: &Arc<RpcContext>, envelope: RequestEnvelope) -> ResponseEnvelope {
    let id = envelope.id.clone();
    match dispatch_inner(ctx, &envelope).await {
        Ok(result) => ResponseEnvelope {
            jsonrpc: "2.0",
            protocol_version: ctx.protocol_version,
            id,
            result: Some(result),
            error: None,
        },
        Err(response) => response,
    }
}

async fn dispatch_inner(
    ctx: &Arc<RpcContext>,
    envelope: &RequestEnvelope,
) -> std::result::Result<Value, ResponseEnvelope> {
    if envelope.jsonrpc != "2.0" {
        return Err(response_error(
            envelope.id.clone(),
            ctx.protocol_version,
            "invalid_jsonrpc",
            "expected jsonrpc=2.0",
            false,
            None,
        ));
    }
    if envelope.protocol_version != ctx.protocol_version {
        return Err(response_error(
            envelope.id.clone(),
            ctx.protocol_version,
            "protocol_mismatch",
            &format!(
                "client protocol {} does not match daemon protocol {}",
                envelope.protocol_version, ctx.protocol_version
            ),
            false,
            Some(
                json!({ "expected": ctx.protocol_version, "received": envelope.protocol_version }),
            ),
        ));
    }
    if let Some(expected) = &ctx.auth_token {
        if envelope.auth_token.as_deref() != Some(expected.as_str()) {
            return Err(response_error(
                envelope.id.clone(),
                ctx.protocol_version,
                "unauthorized",
                "invalid auth token",
                false,
                None,
            ));
        }
    }

    match envelope.method.as_str() {
        "health" => {
            let params = deserialize_params::<HealthParams>(
                &envelope.params,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            validate_project_root(
                &ctx.project_root,
                &params.project_root,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            let stats = ctx.indexer.store_stats().map_err(|error| {
                response_from_error(envelope.id.clone(), ctx.protocol_version, error)
            })?;
            Ok(json_health(ctx, &stats))
        }
        "project.filesChanged" => {
            let params = deserialize_params::<FilesChangedParams>(
                &envelope.params,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            validate_project_root(
                &ctx.project_root,
                &params.project_root,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            let _ = &params.turn_id;
            let _ = params.observed_at_unix_ms;
            ctx.indexer
                .enqueue_files(
                    params.session_id.clone(),
                    params.files.clone(),
                    params.reason.clone(),
                    params.correlation.clone(),
                )
                .await
                .map_err(|error| {
                    response_from_error(envelope.id.clone(), ctx.protocol_version, error)
                })?;
            Ok(json!({ "accepted": true }))
        }
        "analysis.check" => {
            let params = deserialize_params::<CheckParams>(
                &envelope.params,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            validate_project_root(
                &ctx.project_root,
                &params.project_root,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            record_rpc_correlation(&ctx, "analysis.check", &params.correlation)?;
            let summary = ctx
                .indexer
                .check(
                    params.session_id.as_deref(),
                    params.paths.clone(),
                    normalize_max_findings(params.max_findings, &ctx.config),
                    params.wait_for_fresh_index,
                )
                .await
                .map_err(|error| {
                    response_from_error(envelope.id.clone(), ctx.protocol_version, error)
                })?;
            Ok(json_check(summary, params.include_evidence))
        }
        "analysis.driftMap" => {
            let params = deserialize_params::<DriftMapParams>(
                &envelope.params,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            validate_project_root(
                &ctx.project_root,
                &params.project_root,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            record_rpc_correlation(&ctx, "analysis.driftMap", &params.correlation)?;
            let summary = ctx
                .indexer
                .drift_map(
                    params.session_id.as_deref(),
                    normalize_max_findings(params.max_findings, &ctx.config),
                )
                .await
                .map_err(|error| {
                    response_from_error(envelope.id.clone(), ctx.protocol_version, error)
                })?;
            Ok(json_drift_map(summary))
        }
        "analysis.conflicts" => {
            let params = deserialize_params::<ConflictsParams>(
                &envelope.params,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            validate_project_root(
                &ctx.project_root,
                &params.project_root,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            record_rpc_correlation(&ctx, "analysis.conflicts", &params.correlation)?;
            let summary = ctx
                .indexer
                .conflicts(params.session_id.as_deref(), ctx.config.max_findings)
                .await
                .map_err(|error| {
                    response_from_error(envelope.id.clone(), ctx.protocol_version, error)
                })?;
            Ok(json_conflicts(summary))
        }
        "analysis.impactCone" => {
            let params = deserialize_params::<ImpactConeParams>(
                &envelope.params,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            validate_project_root(
                &ctx.project_root,
                &params.project_root,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            record_rpc_correlation(&ctx, "analysis.impactCone", &params.correlation)?;
            let summary = ctx
                .indexer
                .impact_cone(&params.path, params.depth)
                .map_err(|error| {
                    response_from_error(envelope.id.clone(), ctx.protocol_version, error)
                })?;
            Ok(json_impact_cone(summary))
        }
        "analysis.changeRisk" => {
            let params = deserialize_params::<ChangeRiskParams>(
                &envelope.params,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            validate_project_root(
                &ctx.project_root,
                &params.project_root,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            record_rpc_correlation(&ctx, "analysis.changeRisk", &params.correlation)?;
            let summary = ctx
                .indexer
                .change_risk(
                    params.paths,
                    params.depth,
                    params.session_id.as_deref(),
                    normalize_max_findings(params.max_findings, &ctx.config),
                )
                .map_err(|error| {
                    response_from_error(envelope.id.clone(), ctx.protocol_version, error)
                })?;
            Ok(json_change_risk(summary))
        }
        "analysis.apiSurface" => {
            let params = deserialize_params::<ApiSurfaceParams>(
                &envelope.params,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            validate_project_root(
                &ctx.project_root,
                &params.project_root,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            record_rpc_correlation(&ctx, "analysis.apiSurface", &params.correlation)?;
            let summary = ctx
                .indexer
                .api_surface(params.max_exports)
                .map_err(|error| {
                    response_from_error(envelope.id.clone(), ctx.protocol_version, error)
                })?;
            Ok(json_api_surface(summary))
        }
        "analysis.layerBoundaries" => {
            let params = deserialize_params::<LayerBoundariesParams>(
                &envelope.params,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            validate_project_root(
                &ctx.project_root,
                &params.project_root,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            record_rpc_correlation(&ctx, "analysis.layerBoundaries", &params.correlation)?;
            let summary = ctx
                .indexer
                .layer_boundaries(normalize_max_findings(params.max_findings, &ctx.config))
                .map_err(|error| {
                    response_from_error(envelope.id.clone(), ctx.protocol_version, error)
                })?;
            Ok(json_layer_boundaries(summary))
        }
        "analysis.lockfile" => {
            let params = deserialize_params::<LockfileParams>(
                &envelope.params,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            validate_project_root(
                &ctx.project_root,
                &params.project_root,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            let summary = ctx.indexer.lockfiles().map_err(|error| {
                response_from_error(envelope.id.clone(), ctx.protocol_version, error)
            })?;
            Ok(json_lockfile(summary))
        }
        "maintenance.status" => {
            let params = deserialize_params::<HealthParams>(
                &envelope.params,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            validate_project_root(
                &ctx.project_root,
                &params.project_root,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            let stats = ctx.indexer.store_stats().map_err(|error| {
                response_from_error(envelope.id.clone(), ctx.protocol_version, error)
            })?;
            Ok(json!({
                "health": json_health(ctx, &stats),
                "lifecycle": {
                    "pid": std::process::id(),
                    "endpoint": ctx.endpoint,
                    "pidFile": ctx.state_dir.join("run").join("codemem.pid").to_string_lossy(),
                    "stdoutLogFile": ctx.state_dir.join("log").join("daemon.stdout.log").to_string_lossy(),
                    "stderrLogFile": ctx.state_dir.join("log").join("daemon.stderr.log").to_string_lossy(),
                    "lifecycleLogFile": ctx.state_dir.join("log").join("daemon.lifecycle.jsonl").to_string_lossy(),
                },
                "stateDirectory": ctx.state_dir.to_string_lossy(),
                "protocolVersion": ctx.protocol_version,
            }))
        }
        "maintenance.shutdown" => {
            let params = deserialize_params::<HealthParams>(
                &envelope.params,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            validate_project_root(
                &ctx.project_root,
                &params.project_root,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            ctx.shutdown.notify_waiters();
            Ok(json!({ "accepted": true }))
        }
        "maintenance.maintain" => {
            let params = deserialize_params::<MaintainParams>(
                &envelope.params,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            validate_project_root(
                &ctx.project_root,
                &params.project_root,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            let summary = ctx
                .indexer
                .maintain(
                    params.dry_run,
                    params.prune_logs.unwrap_or(false),
                    params.compact.unwrap_or(false),
                )
                .map_err(|error| {
                    response_from_error(envelope.id.clone(), ctx.protocol_version, error)
                })?;
            Ok(json_maintain(summary))
        }
        "maintenance.rebuild" => {
            let params = deserialize_params::<RebuildParams>(
                &envelope.params,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            validate_project_root(
                &ctx.project_root,
                &params.project_root,
                envelope.id.clone(),
                ctx.protocol_version,
            )?;
            let summary = ctx.indexer.rebuild(params.dry_run).await.map_err(|error| {
                response_from_error(envelope.id.clone(), ctx.protocol_version, error)
            })?;
            Ok(json_rebuild(summary))
        }
        _ => Err(response_error(
            envelope.id.clone(),
            ctx.protocol_version,
            "unknown_method",
            &format!("unsupported codemem method {}", envelope.method),
            false,
            None,
        )),
    }
}

fn deserialize_params<T: for<'de> Deserialize<'de>>(
    value: &Value,
    id: Option<String>,
    protocol_version: u32,
) -> std::result::Result<T, ResponseEnvelope> {
    serde_json::from_value(value.clone()).map_err(|error| {
        response_error(
            id,
            protocol_version,
            "invalid_params",
            &error.to_string(),
            false,
            Some(json!({ "params": value })),
        )
    })
}

fn validate_project_root(
    expected: &PathBuf,
    provided: &str,
    id: Option<String>,
    protocol_version: u32,
) -> std::result::Result<(), ResponseEnvelope> {
    let canonical_provided = PathBuf::from(provided);
    if canonical_provided != *expected {
        return Err(response_error(
            id,
            protocol_version,
            "project_mismatch",
            "request projectRoot does not match daemon project root",
            false,
            Some(json!({
                "expected": expected,
                "provided": provided,
            })),
        ));
    }
    Ok(())
}

fn normalize_max_findings(value: usize, config: &ProjectConfig) -> usize {
    let requested = if value == 0 {
        config.max_findings
    } else {
        value
    };
    requested.min(config.max_findings.max(1)).max(1)
}

fn record_rpc_correlation(
    ctx: &RpcContext,
    method: &str,
    correlation: &FleetCorrelation,
) -> std::result::Result<(), ResponseEnvelope> {
    let owner_id = correlation
        .tool_call_id
        .as_deref()
        .or(correlation.correlation_id.as_deref())
        .unwrap_or(method);
    ctx.indexer
        .record_correlation_metadata("rpc", owner_id, correlation)
        .map_err(|error| response_from_error(None, ctx.protocol_version, error))
}

fn response_from_error(
    id: Option<String>,
    protocol_version: u32,
    error: anyhow::Error,
) -> ResponseEnvelope {
    response_error(
        id,
        protocol_version,
        "internal_error",
        &error.to_string(),
        true,
        None,
    )
}

fn response_error(
    id: Option<String>,
    protocol_version: u32,
    code: &str,
    message: &str,
    retryable: bool,
    details: Option<Value>,
) -> ResponseEnvelope {
    ResponseEnvelope {
        jsonrpc: "2.0",
        protocol_version,
        id,
        result: None,
        error: Some(ErrorEnvelope {
            code: code.to_string(),
            message: message.to_string(),
            retryable,
            details,
        }),
    }
}

fn json_health(ctx: &RpcContext, stats: &StoreStats) -> Value {
    let queue_depth = ctx.indexer.queue_depth();
    let dropped_batches = ctx.indexer.dropped_batches();
    let failed_batches = ctx.indexer.failed_batches();
    let queue_status = if queue_depth >= 256 { "fail" } else if queue_depth > 0 { "warn" } else { "ok" };
    let drops_status = if dropped_batches > 0 { "warn" } else { "ok" };
    let failures_status = if failed_batches > 0 { "warn" } else { "ok" };
    let index_status = if stats.indexed_files > 0 { "ok" } else { "warn" };
    let checks = vec![
        json!({
            "name": "protocol_version",
            "status": "ok",
            "message": format!("protocol {}", ctx.protocol_version),
        }),
        json!({
            "name": "schema_version",
            "status": "ok",
            "message": format!("schema {}", SCHEMA_VERSION),
        }),
        json!({
            "name": "queue_depth",
            "status": queue_status,
            "message": format!("{} pending index batches", queue_depth),
        }),
        json!({
            "name": "queue_drops",
            "status": drops_status,
            "message": format!("{} dropped index batches", dropped_batches),
        }),
        json!({
            "name": "index_failures",
            "status": failures_status,
            "message": format!("{} failed index batches", failed_batches),
        }),
        json!({
            "name": "index_state",
            "status": index_status,
            "message": format!("{} files indexed", stats.indexed_files),
        }),
    ];
    let warnings = checks
        .iter()
        .filter_map(|check| {
            if check.get("status").and_then(Value::as_str) == Some("warn") {
                check.get("message").and_then(Value::as_str).map(str::to_string)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    let healthy = checks.iter().all(|check| {
        check
            .get("status")
            .and_then(Value::as_str)
            .map(|status| status != "fail")
            .unwrap_or(false)
    });
    json!({
        "protocolVersion": ctx.protocol_version,
        "schemaVersion": SCHEMA_VERSION,
        "daemonVersion": DAEMON_VERSION,
        "projectRoot": ctx.project_root,
        "startedAtUnixMs": ctx.started_at_unix_ms,
        "healthy": healthy,
        "queueDepth": queue_depth,
        "droppedBatches": dropped_batches,
        "failedBatches": failed_batches,
        "indexedFiles": stats.indexed_files,
        "findingsCacheEntries": stats.findings_cache_entries,
        "warnings": warnings,
        "checks": checks,
    })
}

fn json_check(summary: CheckSummary, include_evidence: bool) -> Value {
    json!({
        "findings": summary.findings.into_iter().map(|finding| finding_to_value(finding, include_evidence)).collect::<Vec<_>>(),
        "truncated": summary.truncated,
        "indexedAtUnixMs": summary.indexed_at_ms,
        "stats": {
            "filesIndexed": summary.stats.indexed_files,
            "scanLatencyMs": summary.scan_latency_ms,
            "cloneBuckets": summary.stats.clone_buckets,
            "typeBuckets": summary.stats.type_buckets,
            "sessionsTracked": summary.stats.sessions_tracked,
        }
    })
}

fn json_drift_map(summary: DriftMapSummary) -> Value {
    json!({
        "map": drift_map_to_value(summary.map),
        "indexedAtUnixMs": summary.indexed_at_ms,
    })
}

fn json_conflicts(summary: ConflictSummary) -> Value {
    json!({
        "findings": summary.findings.into_iter().map(|finding| finding_to_value(finding, true)).collect::<Vec<_>>(),
        "indexedAtUnixMs": summary.indexed_at_ms,
    })
}

fn json_impact_cone(summary: ImpactConeSummary) -> Value {
    json!({
        "path": summary.path,
        "depth": summary.depth,
        "files": summary.files,
        "indexedAtUnixMs": summary.indexed_at_ms,
    })
}

fn json_change_risk(summary: ChangeRiskSummary) -> Value {
    json!({
        "score": summary.score,
        "level": summary.level,
        "paths": summary.paths,
        "depth": summary.depth,
        "reasons": summary.reasons.into_iter().map(|reason| json!({
            "kind": reason.kind,
            "severity": severity_to_str(reason.severity),
            "score": reason.score,
            "detail": reason.detail,
            "files": reason.files,
            "symbols": reason.symbols,
            "findingIds": reason.finding_ids,
        })).collect::<Vec<_>>(),
        "impactedFiles": summary.impacted_files,
        "focus": summary.focus.into_iter().map(|item| json!({
            "target": item.target,
            "targetKind": item.target_kind,
            "severity": severity_to_str(item.severity),
            "confidence": item.confidence,
            "score": item.score,
            "reasons": item.reasons,
            "evidence": evidence_to_value(item.evidence, true),
            "findingIds": item.finding_ids,
        })).collect::<Vec<_>>(),
        "indexedAtUnixMs": summary.indexed_at_ms,
        "stats": {
            "impactedFiles": summary.stats.impacted_files,
            "reverseDependents": summary.stats.reverse_dependents,
            "publicExports": summary.stats.public_exports,
            "findings": summary.stats.findings,
            "sessionConflicts": summary.stats.session_conflicts,
        },
    })
}

fn json_api_surface(summary: ApiSurfaceSummary) -> Value {
    json!({
        "exports": summary.exports.into_iter().map(|export| json!({
            "exportName": export.export_name,
            "sourceFile": export.source_file,
            "signature": export.signature,
        })).collect::<Vec<_>>(),
        "total": summary.total,
        "truncated": summary.truncated,
        "indexedAtUnixMs": summary.indexed_at_ms,
    })
}

fn json_layer_boundaries(summary: LayerBoundarySummary) -> Value {
    json!({
        "boundaries": summary.boundaries.into_iter().map(|boundary| json!({
            "root": boundary.root,
            "name": boundary.name,
            "kind": boundary.kind,
        })).collect::<Vec<_>>(),
        "cycles": summary.cycles.into_iter().map(|finding| finding_to_value(finding, true)).collect::<Vec<_>>(),
        "indexedAtUnixMs": summary.indexed_at_ms,
    })
}

fn json_lockfile(summary: LockfileSummary) -> Value {
    json!({
        "lockfiles": summary.lockfiles.into_iter().map(|lockfile| json!({
            "path": lockfile.path,
            "digest": lockfile.digest,
            "sizeBytes": lockfile.size_bytes,
        })).collect::<Vec<_>>(),
        "indexedAtUnixMs": summary.indexed_at_ms,
    })
}

fn json_maintain(summary: MaintainSummary) -> Value {
    json!({
        "actions": summary.actions.into_iter().map(|action| json!({
            "kind": action.kind,
            "detail": action.detail,
            "estimatedBytes": action.estimated_bytes,
        })).collect::<Vec<_>>(),
        "applied": summary.applied,
    })
}

fn json_rebuild(summary: RebuildSummary) -> Value {
    json!({
        "wouldRebuild": summary.would_rebuild,
        "reason": summary.reason,
    })
}

fn drift_map_to_value(map: DriftMap) -> Value {
    json!({
        "nodes": map.nodes.into_iter().map(|node| json!({
            "id": node.id,
            "label": node.label,
            "kind": node.kind,
            "severity": node.severity.map(severity_to_str),
        })).collect::<Vec<_>>(),
        "edges": map.edges.into_iter().map(|edge| json!({
            "from": edge.from,
            "to": edge.to,
            "kind": edge.kind,
            "dynamic": edge.dynamic,
        })).collect::<Vec<_>>(),
        "findings": map.findings.into_iter().map(|finding| finding_to_value(finding, true)).collect::<Vec<_>>(),
    })
}

fn finding_to_value(finding: Finding, include_evidence: bool) -> Value {
    let id = finding.stable_key();
    match finding {
        Finding::SemanticClone {
            severity,
            confidence,
            evidence,
            action,
            files,
            symbols,
            canonical_hash,
            detector,
            recommendation,
        } => json!({
            "id": id,
            "kind": "semantic_clone",
            "severity": severity_to_str(severity),
            "confidence": confidence,
            "evidence": evidence_to_value(evidence, include_evidence),
            "action": action,
            "files": files,
            "symbols": symbols,
            "canonicalHash": canonical_hash,
            "detector": detector,
            "recommendation": recommendation,
        }),
        Finding::TypeShapeDuplicate {
            severity,
            confidence,
            evidence,
            action,
            symbols,
            shape_hash,
            recommendation,
        } => json!({
            "id": id,
            "kind": "type_shape_duplicate",
            "severity": severity_to_str(severity),
            "confidence": confidence,
            "evidence": evidence_to_value(evidence, include_evidence),
            "action": action,
            "symbols": symbols,
            "shapeHash": shape_hash,
            "recommendation": recommendation,
        }),
        Finding::ApiDrift {
            severity,
            confidence,
            evidence,
            action,
            export_name,
            source_file,
            before,
            after,
            affected_callers,
        } => json!({
            "id": id,
            "kind": "api_drift",
            "severity": severity_to_str(severity),
            "confidence": confidence,
            "evidence": evidence_to_value(evidence, include_evidence),
            "action": action,
            "exportName": export_name,
            "sourceFile": source_file,
            "before": before,
            "after": after,
            "affectedCallers": affected_callers,
        }),
        Finding::DeadCode {
            severity,
            confidence,
            evidence,
            action,
            symbol,
            file,
            reason,
            dynamic_import_risk,
        } => json!({
            "id": id,
            "kind": "dead_code",
            "severity": severity_to_str(severity),
            "confidence": confidence,
            "evidence": evidence_to_value(evidence, include_evidence),
            "action": action,
            "symbol": symbol,
            "file": file,
            "reason": reason,
            "dynamicImportRisk": dynamic_import_risk,
        }),
        Finding::Cycle {
            severity,
            confidence,
            evidence,
            action,
            nodes,
            package_level,
        } => json!({
            "id": id,
            "kind": "cycle",
            "severity": severity_to_str(severity),
            "confidence": confidence,
            "evidence": evidence_to_value(evidence, include_evidence),
            "action": action,
            "nodes": nodes,
            "packageLevel": package_level,
        }),
        Finding::SessionConflict {
            severity,
            confidence,
            evidence,
            action,
            sessions,
            touched_cone,
        } => json!({
            "id": id,
            "kind": "session_conflict",
            "severity": severity_to_str(severity),
            "confidence": confidence,
            "evidence": evidence_to_value(evidence, include_evidence),
            "action": action,
            "sessions": sessions,
            "touchedCone": touched_cone,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ApiSurfaceParams, ChangeRiskParams, CheckParams, ConflictsParams, DriftMapParams,
        FilesChangedParams, ImpactConeParams, LayerBoundariesParams, RequestEnvelope, RpcContext,
        deserialize_params, dispatch, finding_to_value,
    };
    use crate::{
        config::ProjectConfig,
        indexer::Indexer,
        model::{Evidence, Finding, Severity},
        session_conflicts::SessionConflictTracker,
        store::Store,
    };
    use serde_json::json;
    use std::{
        fs,
        path::PathBuf,
        sync::Arc,
        time::{SystemTime, UNIX_EPOCH},
    };
    use tokio::sync::Notify;

    #[tokio::test]
    async fn dispatch_rejects_wrong_auth_token() {
        let ctx = test_context("auth", Some("expected-token".into()));
        let response = dispatch(
            &ctx,
            RequestEnvelope {
                jsonrpc: "2.0".into(),
                protocol_version: ctx.protocol_version,
                id: Some("request-1".into()),
                auth_token: Some("wrong-token".into()),
                method: "analysis.conflicts".into(),
                params: json!({ "projectRoot": ctx.project_root, "sessionID": "session-a" }),
            },
        )
        .await;

        let error = response.error.expect("error response");
        assert_eq!(error.code, "unauthorized");
        assert!(!error.retryable);
    }

    #[tokio::test]
    async fn dispatch_rejects_protocol_mismatch_with_details() {
        let ctx = test_context("protocol", Some("token".into()));
        let response = dispatch(
            &ctx,
            RequestEnvelope {
                jsonrpc: "2.0".into(),
                protocol_version: ctx.protocol_version + 1,
                id: Some("request-2".into()),
                auth_token: Some("token".into()),
                method: "health".into(),
                params: json!({ "projectRoot": ctx.project_root }),
            },
        )
        .await;

        let error = response.error.expect("error response");
        assert_eq!(error.code, "protocol_mismatch");
        assert_eq!(
            error.details.expect("details")["expected"],
            ctx.protocol_version
        );
    }

    #[test]
    fn files_changed_params_accept_opencode_session_id_casing() {
        let params = deserialize_params::<FilesChangedParams>(
            &json!({
                "projectRoot": "/tmp/project",
                "sessionID": "session-a",
                "files": ["src/index.ts"],
                "reason": "tool",
                "turnID": "turn-7",
                "observedAtUnixMs": 1234,
                "workspace_id": "workspace-a",
                "correlation_id": "corr-a",
                "tool_call_id": "tool-call-a"
            }),
            None,
            1,
        )
        .expect("deserialize params");

        assert_eq!(params.session_id, "session-a");
        assert_eq!(params.turn_id.as_deref(), Some("turn-7"));
        assert_eq!(params.correlation.workspace_id.as_deref(), Some("workspace-a"));
        assert_eq!(params.correlation.correlation_id.as_deref(), Some("corr-a"));
        assert_eq!(params.correlation.tool_call_id.as_deref(), Some("tool-call-a"));
    }

    #[test]
    fn change_risk_params_accept_opencode_session_id_casing() {
        let params = deserialize_params::<ChangeRiskParams>(
            &json!({
                "projectRoot": "/tmp/project",
                "paths": ["src/index.ts"],
                "depth": 2,
                "maxFindings": 25,
                "sessionID": "session-a",
                "plan_id": "plan-a",
                "wave_id": "W5",
                "agent_run_id": "agent-run-a",
                "artifact_ref": "artifact-a"
            }),
            None,
            1,
        )
        .expect("deserialize params");

        assert_eq!(params.session_id.as_deref(), Some("session-a"));
        assert_eq!(params.paths, vec!["src/index.ts"]);
        assert_eq!(params.correlation.plan_id.as_deref(), Some("plan-a"));
        assert_eq!(params.correlation.wave_id.as_deref(), Some("W5"));
        assert_eq!(params.correlation.agent_run_id.as_deref(), Some("agent-run-a"));
        assert_eq!(params.correlation.artifact_ref.as_deref(), Some("artifact-a"));
    }

    #[test]
    fn analysis_params_round_trip_fleet_correlation() {
        let base_correlation = json!({
            "workspace_id": "workspace-a",
            "plan_id": "plan-a",
            "plan_slug": "plan-slug-a",
            "wave_id": "W5",
            "agent_run_id": "agent-run-a",
            "correlation_id": "corr-a",
            "tool_call_id": "tool-call-a",
            "artifact_ref": "artifact-a",
            "lifecycle_object_id": "lifecycle-a",
            "concord_event_id": "concord-a",
            "fleet_run_id": "fleet-a",
            "spine_seq": 7
        });

        let check = deserialize_params::<CheckParams>(
            &merge_json(
                json!({
                    "projectRoot": "/tmp/project",
                    "maxFindings": 25,
                    "includeEvidence": true,
                    "waitForFreshIndex": false
                }),
                base_correlation.clone(),
            ),
            None,
            1,
        )
        .expect("deserialize check params");
        assert_fleet_correlation(serde_json::to_value(check).expect("serialize check params"));

        let drift_map = deserialize_params::<DriftMapParams>(
            &merge_json(
                json!({ "projectRoot": "/tmp/project", "maxFindings": 25 }),
                base_correlation.clone(),
            ),
            None,
            1,
        )
        .expect("deserialize drift map params");
        assert_fleet_correlation(serde_json::to_value(drift_map).expect("serialize drift map params"));

        let conflicts = deserialize_params::<ConflictsParams>(
            &merge_json(json!({ "projectRoot": "/tmp/project" }), base_correlation.clone()),
            None,
            1,
        )
        .expect("deserialize conflicts params");
        assert_fleet_correlation(serde_json::to_value(conflicts).expect("serialize conflicts params"));

        let impact_cone = deserialize_params::<ImpactConeParams>(
            &merge_json(
                json!({ "projectRoot": "/tmp/project", "path": "src/index.ts", "depth": 2 }),
                base_correlation.clone(),
            ),
            None,
            1,
        )
        .expect("deserialize impact cone params");
        assert_fleet_correlation(
            serde_json::to_value(impact_cone).expect("serialize impact cone params"),
        );

        let api_surface = deserialize_params::<ApiSurfaceParams>(
            &merge_json(
                json!({ "projectRoot": "/tmp/project", "maxExports": 25 }),
                base_correlation.clone(),
            ),
            None,
            1,
        )
        .expect("deserialize api surface params");
        assert_fleet_correlation(
            serde_json::to_value(api_surface).expect("serialize api surface params"),
        );

        let layer_boundaries = deserialize_params::<LayerBoundariesParams>(
            &merge_json(
                json!({ "projectRoot": "/tmp/project", "maxFindings": 25 }),
                base_correlation,
            ),
            None,
            1,
        )
        .expect("deserialize layer boundaries params");
        assert_fleet_correlation(
            serde_json::to_value(layer_boundaries).expect("serialize layer boundaries params"),
        );
    }

    fn assert_fleet_correlation(value: serde_json::Value) {
        assert_eq!(value["workspace_id"], "workspace-a");
        assert_eq!(value["plan_id"], "plan-a");
        assert_eq!(value["plan_slug"], "plan-slug-a");
        assert_eq!(value["wave_id"], "W5");
        assert_eq!(value["agent_run_id"], "agent-run-a");
        assert_eq!(value["correlation_id"], "corr-a");
        assert_eq!(value["tool_call_id"], "tool-call-a");
        assert_eq!(value["artifact_ref"], "artifact-a");
        assert_eq!(value["lifecycle_object_id"], "lifecycle-a");
        assert_eq!(value["concord_event_id"], "concord-a");
        assert_eq!(value["fleet_run_id"], "fleet-a");
        assert_eq!(value["spine_seq"], 7);
    }

    fn merge_json(mut left: serde_json::Value, right: serde_json::Value) -> serde_json::Value {
        let left_object = left.as_object_mut().expect("left JSON object");
        let right_object = right.as_object().expect("right JSON object");
        for (key, value) in right_object {
            left_object.insert(key.clone(), value.clone());
        }
        left
    }

    #[test]
    fn serialized_findings_include_stable_id() {
        let value = finding_to_value(
            Finding::DeadCode {
                severity: Severity::Warn,
                confidence: 0.8,
                evidence: vec![Evidence {
                    kind: "span".into(),
                    file: Some("src/index.ts".into()),
                    symbol: Some("unused".into()),
                    span: None,
                    detail: "symbol is unreachable".into(),
                    score: None,
                }],
                action: "Remove the symbol or add an entrypoint.".into(),
                symbol: "unused".into(),
                file: "src/index.ts".into(),
                reason: "not reachable from entrypoints".into(),
                dynamic_import_risk: false,
            },
            true,
        );

        assert_eq!(value["id"], "dead:src/index.ts:unused");
    }

    fn test_context(name: &str, auth_token: Option<String>) -> Arc<RpcContext> {
        let project_root = temp_dir(&format!("{name}-project"));
        let state_dir = temp_dir(&format!("{name}-state"));
        fs::create_dir_all(&project_root).expect("create project root");
        fs::create_dir_all(&state_dir).expect("create state dir");

        let config = Arc::new(ProjectConfig::default());
        let store = Arc::new(Store::open(&state_dir).expect("open store"));
        let sessions = Arc::new(SessionConflictTracker::new(
            config.thresholds.session_conflict_decay_ms,
            Arc::clone(&store),
        ));
        let indexer = Indexer::new(
            project_root.clone(),
            state_dir.clone(),
            Arc::clone(&config),
            Arc::clone(&store),
            sessions,
        )
        .expect("create indexer");

        Arc::new(RpcContext {
            protocol_version: 1,
            auth_token,
            endpoint: "test-endpoint".into(),
            project_root,
            state_dir,
            config,
            indexer,
            started_at_unix_ms: 0,
            shutdown: Arc::new(Notify::new()),
        })
    }

    fn temp_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "codemem-rpc-{name}-{}-{unique}",
            std::process::id()
        ))
    }
}

fn evidence_to_value(evidence: Vec<Evidence>, include_evidence: bool) -> Value {
    if !include_evidence {
        return json!([]);
    }
    json!(
        evidence
            .into_iter()
            .map(|evidence| json!({
                "kind": evidence.kind,
                "file": evidence.file,
                "symbol": evidence.symbol,
                "span": evidence.span.map(|span| json!({
                    "startLine": span.start_line,
                    "startColumn": span.start_column,
                    "endLine": span.end_line,
                    "endColumn": span.end_column,
                })),
                "detail": evidence.detail,
                "score": evidence.score,
            }))
            .collect::<Vec<_>>()
    )
}

fn severity_to_str(severity: Severity) -> &'static str {
    match severity {
        Severity::Info => "info",
        Severity::Warn => "warn",
        Severity::Error => "error",
    }
}
