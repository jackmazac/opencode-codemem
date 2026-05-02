use crate::{
    config::ProjectConfig,
    model::{Evidence, Finding, Severity, TypeShapeRecord},
};
use blake3::Hasher;
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
pub struct TypeShapeDetector {
    enabled: bool,
    min_members: usize,
}

impl TypeShapeDetector {
    pub fn new(config: &ProjectConfig) -> Self {
        Self {
            enabled: config.layers.type_shapes,
            min_members: config.thresholds.type_shape_min_members,
        }
    }

    pub fn analyze_file(
        &self,
        relative_path: &str,
        source: &str,
        generated: bool,
    ) -> Vec<TypeShapeRecord> {
        if generated || !self.enabled {
            return Vec::new();
        }

        let mut records = Vec::new();
        for shape in extract_shapes(source) {
            if shape.members.len() < self.min_members {
                continue;
            }
            let fingerprint_json =
                serde_json::to_string(&shape.members).unwrap_or_else(|_| "[]".to_string());
            let shape_hash = hash_members(&shape.members);
            let suppressed = suppress_shape(&shape.members);
            records.push(TypeShapeRecord {
                file_path: relative_path.to_string(),
                symbol: shape.symbol,
                shape_hash,
                fingerprint_json,
                depth: shape.depth,
                suppressed,
            });
        }
        records
    }

    pub fn detect(&self, records: &[TypeShapeRecord], max_findings: usize) -> Vec<Finding> {
        if !self.enabled {
            return Vec::new();
        }

        let mut buckets: BTreeMap<&str, Vec<&TypeShapeRecord>> = BTreeMap::new();
        for record in records {
            if record.suppressed {
                continue;
            }
            buckets
                .entry(record.shape_hash.as_str())
                .or_default()
                .push(record);
        }

        let mut findings = Vec::new();
        for (shape_hash, bucket) in buckets {
            let unique_symbols = bucket
                .iter()
                .map(|record| format!("{}::{}", record.file_path, record.symbol))
                .collect::<BTreeSet<_>>();
            if unique_symbols.len() < 2 {
                continue;
            }
            let symbols = unique_symbols.into_iter().collect::<Vec<_>>();
            let evidence = bucket
                .iter()
                .take(4)
                .map(|record| Evidence {
                    kind: "signature".into(),
                    file: Some(record.file_path.clone()),
                    symbol: Some(record.symbol.clone()),
                    span: None,
                    detail: format!(
                        "shape hash {} with normalized members {}",
                        &record.shape_hash[..record.shape_hash.len().min(12)],
                        compact_members(&record.fingerprint_json)
                    ),
                    score: Some(0.93),
                })
                .collect::<Vec<_>>();

            findings.push(Finding::TypeShapeDuplicate {
                severity: Severity::Warn,
                confidence: 0.93,
                evidence,
                action: "Replace parallel DTO/type aliases with a shared canonical type or explicitly document why the duplication is intentional.".into(),
                symbols,
                shape_hash: shape_hash.to_string(),
                recommendation: "Merge structurally identical types before field additions diverge across agents.".into(),
            });
            if findings.len() >= max_findings {
                break;
            }
        }

        findings
    }
}

#[derive(Debug, Clone)]
struct ShapeCandidate {
    symbol: String,
    depth: u8,
    members: Vec<String>,
}

fn extract_shapes(source: &str) -> Vec<ShapeCandidate> {
    let interface_re = Regex::new(
        r"(?m)^\s*(?:export\s+)?interface\s+([A-Za-z_][A-Za-z0-9_]*)(?:<[^\n{]+>)?\s*\{",
    )
    .unwrap();
    let type_re =
        Regex::new(r"(?m)^\s*(?:export\s+)?type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{").unwrap();
    let class_re = Regex::new(
        r"(?m)^\s*(?:export\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)(?:<[^\n{]+>)?(?:\s+extends\s+[^\n{]+)?\s*\{",
    )
    .unwrap();

    let mut shapes = Vec::new();
    for captures in interface_re.captures_iter(source) {
        if let Some(candidate) = capture_shape(source, &captures, "interface") {
            shapes.push(candidate);
        }
    }
    for captures in type_re.captures_iter(source) {
        if let Some(candidate) = capture_shape(source, &captures, "type") {
            shapes.push(candidate);
        }
    }
    for captures in class_re.captures_iter(source) {
        if let Some(candidate) = capture_shape(source, &captures, "class") {
            shapes.push(candidate);
        }
    }
    shapes
}

fn capture_shape(
    source: &str,
    captures: &regex::Captures<'_>,
    kind: &str,
) -> Option<ShapeCandidate> {
    let whole = captures.get(0)?;
    let name = captures.get(1)?.as_str().to_string();
    let body_start = source[whole.start()..]
        .find('{')
        .map(|offset| whole.start() + offset)?;
    let body_end = match_brace(source, body_start)?;
    let body = &source[body_start + 1..body_end];
    let members = match kind {
        "class" => parse_class_members(body),
        _ => parse_object_members(body),
    };
    Some(ShapeCandidate {
        symbol: name,
        depth: estimate_depth(&members),
        members,
    })
}

fn match_brace(source: &str, open_offset: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut depth = 0usize;
    let mut in_single = false;
    let mut in_double = false;
    let mut in_template = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut escaping = false;

    for (index, byte) in bytes.iter().enumerate().skip(open_offset) {
        let current = *byte as char;
        let next = bytes.get(index + 1).copied().map(char::from);
        let previous = if index == 0 {
            None
        } else {
            bytes.get(index - 1).copied().map(char::from)
        };

        if in_line_comment {
            if current == '\n' {
                in_line_comment = false;
            }
            continue;
        }
        if in_block_comment {
            if previous == Some('*') && current == '/' {
                in_block_comment = false;
            }
            continue;
        }
        if in_single {
            if escaping {
                escaping = false;
            } else if current == '\\' {
                escaping = true;
            } else if current == '\'' {
                in_single = false;
            }
            continue;
        }
        if in_double {
            if escaping {
                escaping = false;
            } else if current == '\\' {
                escaping = true;
            } else if current == '"' {
                in_double = false;
            }
            continue;
        }
        if in_template {
            if escaping {
                escaping = false;
            } else if current == '\\' {
                escaping = true;
            } else if current == '`' {
                in_template = false;
            }
            continue;
        }

        if current == '/' && next == Some('/') {
            in_line_comment = true;
            continue;
        }
        if current == '/' && next == Some('*') {
            in_block_comment = true;
            continue;
        }
        if current == '\'' {
            in_single = true;
            continue;
        }
        if current == '"' {
            in_double = true;
            continue;
        }
        if current == '`' {
            in_template = true;
            continue;
        }

        if current == '{' {
            depth += 1;
        } else if current == '}' {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Some(index);
            }
        }
    }
    None
}

fn parse_object_members(body: &str) -> Vec<String> {
    let property_re = Regex::new(
        r#"(?m)^\s*(readonly\s+)?([A-Za-z_][A-Za-z0-9_]*|['"][^'"]+['"])(\?)?\s*:\s*([^;]+);?"#,
    )
    .unwrap();
    let method_re =
        Regex::new(r"(?m)^\s*([A-Za-z_][A-Za-z0-9_]*)(\?)?\s*\(([^)]*)\)\s*:\s*([^;{]+);?")
            .unwrap();
    let index_re = Regex::new(r"(?m)^\s*\[[^\]]+\]\s*:\s*([^;]+);?").unwrap();

    let mut members = Vec::new();
    for captures in property_re.captures_iter(body) {
        let readonly = captures.get(1).is_some();
        let name = normalize_member_name(captures.get(2).map(|m| m.as_str()).unwrap_or("prop"));
        let optional = captures.get(3).is_some();
        let ty = normalize_type(captures.get(4).map(|m| m.as_str()).unwrap_or("unknown"));
        members.push(format!(
            "prop:{}:{}:{}:{}",
            name,
            if readonly { "ro" } else { "rw" },
            if optional { "opt" } else { "req" },
            ty
        ));
    }
    for captures in method_re.captures_iter(body) {
        let name = normalize_member_name(captures.get(1).map(|m| m.as_str()).unwrap_or("method"));
        let optional = captures.get(2).is_some();
        let params = normalize_params(captures.get(3).map(|m| m.as_str()).unwrap_or(""));
        let return_type = normalize_type(captures.get(4).map(|m| m.as_str()).unwrap_or("void"));
        members.push(format!(
            "method:{}:{}:{}->{}",
            name,
            if optional { "opt" } else { "req" },
            params.join(","),
            return_type
        ));
    }
    for captures in index_re.captures_iter(body) {
        let ty = normalize_type(captures.get(1).map(|m| m.as_str()).unwrap_or("unknown"));
        members.push(format!("index:{}", ty));
    }
    members.sort();
    members.dedup();
    members
}

fn parse_class_members(body: &str) -> Vec<String> {
    let property_re = Regex::new(
        r"(?m)^\s*(?:public\s+)?(readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)(\?)?\s*:\s*([^;=]+)(?:=[^;]+)?;?",
    )
    .unwrap();
    let method_re = Regex::new(
        r"(?m)^\s*(?:public\s+)?(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)(\?)?\s*\(([^)]*)\)\s*:\s*([^\n{]+)\{?",
    )
    .unwrap();

    let mut members = Vec::new();
    for captures in property_re.captures_iter(body) {
        let name = captures.get(2).map(|m| m.as_str()).unwrap_or("field");
        if matches!(name, "constructor") {
            continue;
        }
        let readonly = captures.get(1).is_some();
        let optional = captures.get(3).is_some();
        let ty = normalize_type(captures.get(4).map(|m| m.as_str()).unwrap_or("unknown"));
        members.push(format!(
            "prop:{}:{}:{}:{}",
            normalize_member_name(name),
            if readonly { "ro" } else { "rw" },
            if optional { "opt" } else { "req" },
            ty
        ));
    }
    for captures in method_re.captures_iter(body) {
        let name = captures.get(1).map(|m| m.as_str()).unwrap_or("method");
        if matches!(name, "constructor") {
            continue;
        }
        let optional = captures.get(2).is_some();
        let params = normalize_params(captures.get(3).map(|m| m.as_str()).unwrap_or(""));
        let return_type = normalize_type(captures.get(4).map(|m| m.as_str()).unwrap_or("void"));
        members.push(format!(
            "method:{}:{}:{}->{}",
            normalize_member_name(name),
            if optional { "opt" } else { "req" },
            params.join(","),
            return_type
        ));
    }
    members.sort();
    members.dedup();
    members
}

fn normalize_member_name(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_string()
}

fn normalize_params(value: &str) -> Vec<String> {
    value
        .split(',')
        .filter_map(|part| {
            let part = part.trim();
            if part.is_empty() {
                return None;
            }
            let mut pieces = part.split(':');
            let _name = pieces.next();
            let ty = pieces.next().unwrap_or("unknown");
            Some(normalize_type(ty))
        })
        .collect()
}

fn normalize_type(value: &str) -> String {
    let mut type_text = value
        .replace('\n', " ")
        .replace('\t', " ")
        .replace("readonly ", "")
        .replace("extends ", "")
        .replace("<", "<")
        .replace(">", ">")
        .trim()
        .to_string();
    while type_text.contains("  ") {
        type_text = type_text.replace("  ", " ");
    }

    let identifier_re = Regex::new(r"\b[A-Za-z_][A-Za-z0-9_]*\b").unwrap();
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
        "record",
        "array",
        "promise",
        "date",
        "map",
        "set",
        "readonlyarray",
        "bigint",
        "symbol",
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();

    type_text = identifier_re
        .replace_all(&type_text, |captures: &regex::Captures<'_>| {
            let token = captures.get(0).map(|m| m.as_str()).unwrap_or("T");
            if builtins.contains(&token.to_ascii_lowercase().as_str()) {
                token.to_ascii_lowercase()
            } else {
                "T".to_string()
            }
        })
        .to_string();

    if type_text.contains('|') {
        let mut parts = type_text
            .split('|')
            .map(|part| part.trim().to_string())
            .collect::<Vec<_>>();
        parts.sort();
        parts.dedup();
        type_text = parts.join("|");
    }
    if type_text.contains('&') {
        let mut parts = type_text
            .split('&')
            .map(|part| part.trim().to_string())
            .collect::<Vec<_>>();
        parts.sort();
        parts.dedup();
        type_text = parts.join("&");
    }

    type_text.replace(' ', "")
}

fn estimate_depth(members: &[String]) -> u8 {
    let nested = members
        .iter()
        .map(|member| member.matches('{').count() + member.matches('<').count())
        .max()
        .unwrap_or(0);
    nested.min(8) as u8
}

fn hash_members(members: &[String]) -> String {
    let mut hasher = Hasher::new();
    for member in members {
        hasher.update(member.as_bytes());
        hasher.update(b"\0");
    }
    hasher.finalize().to_hex().to_string()
}

fn suppress_shape(members: &[String]) -> bool {
    if members.len() < 3 {
        return true;
    }
    let common = [
        [
            "prop:id:rw:req:string",
            "prop:name:rw:req:string",
            "prop:createdAt:rw:req:T",
        ],
        [
            "prop:code:rw:req:string",
            "prop:message:rw:req:string",
            "prop:status:rw:req:number",
        ],
    ];
    common.iter().any(|pattern| {
        pattern
            .iter()
            .all(|expected| members.iter().any(|member| member.starts_with(expected)))
    })
}

fn compact_members(fingerprint_json: &str) -> String {
    serde_json::from_str::<Vec<String>>(fingerprint_json)
        .unwrap_or_default()
        .into_iter()
        .take(5)
        .collect::<Vec<_>>()
        .join(",")
}
