use crate::{
    config::ProjectConfig,
    indexer::{CheckSummary, ConflictSummary, DriftMapSummary, Indexer, MaintainSummary, RebuildSummary},
    model::{DriftMap, Evidence, Finding, Severity, StoreStats},
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilesChangedParams {
    project_root: String,
    session_id: String,
    files: Vec<String>,
    reason: String,
    turn_id: Option<String>,
    observed_at_unix_ms: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckParams {
    project_root: String,
    session_id: Option<String>,
    paths: Option<Vec<String>>,
    max_findings: usize,
    include_evidence: bool,
    wait_for_fresh_index: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriftMapParams {
    project_root: String,
    session_id: Option<String>,
    max_findings: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConflictsParams {
    project_root: String,
    session_id: Option<String>,
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
    Err(anyhow::anyhow!("unsupported platform for codemem local RPC"))
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
                let response = response_error(None, ctx.protocol_version, "invalid_frame", &error.to_string(), true, None);
                let _ = write_response(&mut stream, &response).await;
                return Err(error);
            }
        };

        let envelope: RequestEnvelope = match serde_json::from_slice(&request) {
            Ok(envelope) => envelope,
            Err(error) => {
                let response = response_error(None, ctx.protocol_version, "invalid_json", &error.to_string(), false, None);
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
        return Err(anyhow::anyhow!("frame exceeds codemem limit ({length} bytes)"));
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
        return Err(response_error(envelope.id.clone(), ctx.protocol_version, "invalid_jsonrpc", "expected jsonrpc=2.0", false, None));
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
            Some(json!({ "expected": ctx.protocol_version, "received": envelope.protocol_version })),
        ));
    }
    if let Some(expected) = &ctx.auth_token {
        if envelope.auth_token.as_deref() != Some(expected.as_str()) {
            return Err(response_error(envelope.id.clone(), ctx.protocol_version, "unauthorized", "invalid auth token", false, None));
        }
    }

    match envelope.method.as_str() {
        "health" => {
            let params = deserialize_params::<HealthParams>(&envelope.params, envelope.id.clone(), ctx.protocol_version)?;
            validate_project_root(&ctx.project_root, &params.project_root, envelope.id.clone(), ctx.protocol_version)?;
            let stats = ctx
                .indexer
                .store_stats()
                .map_err(|error| response_from_error(envelope.id.clone(), ctx.protocol_version, error))?;
            Ok(json_health(ctx, &stats))
        }
        "project.filesChanged" => {
            let params = deserialize_params::<FilesChangedParams>(&envelope.params, envelope.id.clone(), ctx.protocol_version)?;
            validate_project_root(&ctx.project_root, &params.project_root, envelope.id.clone(), ctx.protocol_version)?;
            let _ = &params.turn_id;
            let _ = params.observed_at_unix_ms;
            ctx.indexer
                .enqueue_files(params.session_id.clone(), params.files.clone(), params.reason.clone())
                .await
                .map_err(|error| response_from_error(envelope.id.clone(), ctx.protocol_version, error))?;
            Ok(json!({ "accepted": true }))
        }
        "analysis.check" => {
            let params = deserialize_params::<CheckParams>(&envelope.params, envelope.id.clone(), ctx.protocol_version)?;
            validate_project_root(&ctx.project_root, &params.project_root, envelope.id.clone(), ctx.protocol_version)?;
            let summary = ctx
                .indexer
                .check(
                    params.session_id.as_deref(),
                    params.paths.clone(),
                    normalize_max_findings(params.max_findings, &ctx.config),
                    params.wait_for_fresh_index,
                )
                .await
                .map_err(|error| response_from_error(envelope.id.clone(), ctx.protocol_version, error))?;
            Ok(json_check(summary, params.include_evidence))
        }
        "analysis.driftMap" => {
            let params = deserialize_params::<DriftMapParams>(&envelope.params, envelope.id.clone(), ctx.protocol_version)?;
            validate_project_root(&ctx.project_root, &params.project_root, envelope.id.clone(), ctx.protocol_version)?;
            let summary = ctx
                .indexer
                .drift_map(
                    params.session_id.as_deref(),
                    normalize_max_findings(params.max_findings, &ctx.config),
                )
                .await
                .map_err(|error| response_from_error(envelope.id.clone(), ctx.protocol_version, error))?;
            Ok(json_drift_map(summary))
        }
        "analysis.conflicts" => {
            let params = deserialize_params::<ConflictsParams>(&envelope.params, envelope.id.clone(), ctx.protocol_version)?;
            validate_project_root(&ctx.project_root, &params.project_root, envelope.id.clone(), ctx.protocol_version)?;
            let summary = ctx
                .indexer
                .conflicts(params.session_id.as_deref(), ctx.config.max_findings)
                .await
                .map_err(|error| response_from_error(envelope.id.clone(), ctx.protocol_version, error))?;
            Ok(json_conflicts(summary))
        }
        "maintenance.status" => {
            let params = deserialize_params::<HealthParams>(&envelope.params, envelope.id.clone(), ctx.protocol_version)?;
            validate_project_root(&ctx.project_root, &params.project_root, envelope.id.clone(), ctx.protocol_version)?;
            let stats = ctx
                .indexer
                .store_stats()
                .map_err(|error| response_from_error(envelope.id.clone(), ctx.protocol_version, error))?;
            Ok(json!({
                "health": json_health(ctx, &stats),
                "stateDirectory": ctx.state_dir.to_string_lossy(),
                "protocolVersion": ctx.protocol_version,
            }))
        }
        "maintenance.maintain" => {
            let params = deserialize_params::<MaintainParams>(&envelope.params, envelope.id.clone(), ctx.protocol_version)?;
            validate_project_root(&ctx.project_root, &params.project_root, envelope.id.clone(), ctx.protocol_version)?;
            let summary = ctx
                .indexer
                .maintain(params.dry_run, params.prune_logs.unwrap_or(false), params.compact.unwrap_or(false))
                .map_err(|error| response_from_error(envelope.id.clone(), ctx.protocol_version, error))?;
            Ok(json_maintain(summary))
        }
        "maintenance.rebuild" => {
            let params = deserialize_params::<RebuildParams>(&envelope.params, envelope.id.clone(), ctx.protocol_version)?;
            validate_project_root(&ctx.project_root, &params.project_root, envelope.id.clone(), ctx.protocol_version)?;
            let summary = ctx
                .indexer
                .rebuild(params.dry_run)
                .await
                .map_err(|error| response_from_error(envelope.id.clone(), ctx.protocol_version, error))?;
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
    let requested = if value == 0 { config.max_findings } else { value };
    requested.min(config.max_findings.max(1)).max(1)
}

fn response_from_error(id: Option<String>, protocol_version: u32, error: anyhow::Error) -> ResponseEnvelope {
    response_error(id, protocol_version, "internal_error", &error.to_string(), true, None)
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
    json!({
        "protocolVersion": ctx.protocol_version,
        "schemaVersion": SCHEMA_VERSION,
        "daemonVersion": DAEMON_VERSION,
        "projectRoot": ctx.project_root,
        "startedAtUnixMs": ctx.started_at_unix_ms,
        "healthy": true,
        "queueDepth": ctx.indexer.queue_depth(),
        "indexedFiles": stats.indexed_files,
        "findingsCacheEntries": stats.findings_cache_entries,
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
    use super::{dispatch, RequestEnvelope, RpcContext};
    use crate::{
        config::ProjectConfig,
        indexer::Indexer,
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
        assert_eq!(error.details.expect("details")["expected"], ctx.protocol_version);
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
        })
    }

    fn temp_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("codemem-rpc-{name}-{}-{unique}", std::process::id()))
    }
}

fn evidence_to_value(evidence: Vec<Evidence>, include_evidence: bool) -> Value {
    if !include_evidence {
        return json!([]);
    }
    json!(evidence
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
        .collect::<Vec<_>>())
}

fn severity_to_str(severity: Severity) -> &'static str {
    match severity {
        Severity::Info => "info",
        Severity::Warn => "warn",
        Severity::Error => "error",
    }
}
