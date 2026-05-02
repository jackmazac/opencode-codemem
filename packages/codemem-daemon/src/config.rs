use anyhow::{Context, Result};
use globset::{Glob, GlobSet, GlobSetBuilder};
use json_comments::StripComments;
use serde::{Deserialize, Serialize};
use std::{fs::File, io::Read, path::Path};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Layers {
    pub ast_clones: bool,
    pub simhash_clones: bool,
    pub semantic_clones: bool,
    pub type_shapes: bool,
    pub symbol_graph: bool,
    pub api_drift: bool,
    pub session_conflicts: bool,
    pub dynamic_dead_code: bool,
}

impl Default for Layers {
    fn default() -> Self {
        Self {
            ast_clones: true,
            simhash_clones: true,
            semantic_clones: false,
            type_shapes: true,
            symbol_graph: true,
            api_drift: true,
            session_conflicts: true,
            dynamic_dead_code: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Thresholds {
    pub min_clone_tokens: usize,
    pub min_clone_statements: usize,
    pub simhash_hamming_radius: u8,
    pub semantic_clone_cosine: f64,
    pub semantic_candidate_k: usize,
    pub max_findings: usize,
    pub type_shape_min_members: usize,
    pub session_conflict_overlap: f64,
    pub session_conflict_decay_ms: i64,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            min_clone_tokens: 24,
            min_clone_statements: 3,
            simhash_hamming_radius: 6,
            semantic_clone_cosine: 0.88,
            semantic_candidate_k: 16,
            max_findings: 50,
            type_shape_min_members: 3,
            session_conflict_overlap: 0.25,
            session_conflict_decay_ms: 15 * 60 * 1_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Telemetry {
    pub enabled: bool,
    pub retain_days: i64,
    pub max_log_bytes: usize,
}

impl Default for Telemetry {
    fn default() -> Self {
        Self { enabled: true, retain_days: 14, max_log_bytes: 8 * 1024 * 1024 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PackageBoundary {
    pub root: String,
    pub name: Option<String>,
    pub kind: Option<String>,
}

impl Default for PackageBoundary {
    fn default() -> Self {
        Self { root: String::new(), name: None, kind: None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProjectConfig {
    pub entrypoints: Vec<String>,
    pub ignore: Vec<String>,
    pub package_boundaries: Vec<PackageBoundary>,
    pub layers: Layers,
    pub thresholds: Thresholds,
    pub telemetry: Telemetry,
    pub max_findings: usize,
}

impl Default for ProjectConfig {
    fn default() -> Self {
        Self {
            entrypoints: vec!["src/index.ts".into()],
            ignore: vec![
                "node_modules/**".into(),
                "**/node_modules/**".into(),
                ".opencode/**".into(),
                "dist/**".into(),
                "**/dist/**".into(),
                "build/**".into(),
                ".next/**".into(),
                "coverage/**".into(),
                "**/*.generated.ts".into(),
                "**/*.generated.tsx".into(),
                "**/*.gen.ts".into(),
                "**/*.gen.tsx".into(),
            ],
            package_boundaries: Vec::new(),
            layers: Layers::default(),
            thresholds: Thresholds::default(),
            telemetry: Telemetry::default(),
            max_findings: 50,
        }
    }
}

impl ProjectConfig {
    pub fn ignore_set(&self) -> Result<GlobSet> {
        let mut builder = GlobSetBuilder::new();
        for pattern in &self.ignore {
            builder.add(Glob::new(pattern).with_context(|| format!("invalid ignore glob: {pattern}"))?);
        }
        Ok(builder.build()?)
    }
}

pub fn load_project_config(project_root: &Path) -> Result<ProjectConfig> {
    let candidates = [
        project_root.join("codemem.config.jsonc"),
        project_root.join("codemem.config.json"),
        project_root.join(".codememrc.jsonc"),
    ];

    for candidate in candidates {
        if candidate.is_file() {
            return load_specific_config(&candidate);
        }
    }

    Ok(ProjectConfig::default())
}

fn load_specific_config(path: &Path) -> Result<ProjectConfig> {
    let mut file = File::open(path).with_context(|| format!("failed to open config: {}", path.display()))?;
    let mut raw = String::new();
    file.read_to_string(&mut raw)?;
    let mut stripped = String::new();
    StripComments::new(raw.as_bytes()).read_to_string(&mut stripped)?;
    let config: ProjectConfig = serde_json::from_str(&stripped)
        .with_context(|| format!("failed to parse config: {}", path.display()))?;
    Ok(config)
}

pub fn normalize_rel(project_root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(project_root).unwrap_or(path);
    relative.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::load_specific_config;
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn loads_camel_case_jsonc_fields() {
        let config_path = temp_config_path("camel-case");
        fs::write(
            &config_path,
            r#"{
              // The shared TypeScript config and example file use camelCase keys.
              "entrypoints": ["src/main.ts"],
              "packageBoundaries": [{ "root": "packages/*", "kind": "workspace" }],
              "layers": {
                "astClones": false,
                "simhashClones": false,
                "semanticClones": true,
                "typeShapes": false,
                "symbolGraph": false,
                "apiDrift": false,
                "sessionConflicts": false,
                "dynamicDeadCode": false
              },
              "thresholds": {
                "minCloneTokens": 41,
                "minCloneStatements": 5,
                "simhashHammingRadius": 9,
                "semanticCloneCosine": 0.91,
                "semanticCandidateK": 7,
                "maxFindings": 13,
                "typeShapeMinMembers": 6,
                "sessionConflictOverlap": 0.42,
                "sessionConflictDecayMs": 1234
              },
              "telemetry": {
                "enabled": false,
                "retainDays": 3,
                "maxLogBytes": 2048
              },
              "maxFindings": 13
            }"#,
        )
        .expect("write test config");

        let config = load_specific_config(&config_path).expect("load config");

        assert_eq!(config.entrypoints, vec!["src/main.ts"]);
        assert_eq!(config.package_boundaries.len(), 1);
        assert_eq!(config.package_boundaries[0].root, "packages/*");
        assert_eq!(config.package_boundaries[0].kind.as_deref(), Some("workspace"));
        assert!(!config.layers.ast_clones);
        assert!(config.layers.semantic_clones);
        assert_eq!(config.thresholds.min_clone_tokens, 41);
        assert_eq!(config.thresholds.simhash_hamming_radius, 9);
        assert_eq!(config.thresholds.semantic_candidate_k, 7);
        assert!(!config.telemetry.enabled);
        assert_eq!(config.telemetry.retain_days, 3);
        assert_eq!(config.max_findings, 13);

        fs::remove_file(config_path).expect("remove test config");
    }

    #[test]
    fn default_ignore_skips_nested_dependency_and_opencode_state_dirs() {
        let config = super::ProjectConfig::default();

        assert!(config.ignore.iter().any(|pattern| pattern == "**/node_modules/**"));
        assert!(config.ignore.iter().any(|pattern| pattern == "**/dist/**"));
        assert!(config.ignore.iter().any(|pattern| pattern == ".opencode/**"));
    }

    fn temp_config_path(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("codemem-{name}-{}-{unique}.jsonc", std::process::id()))
    }
}

