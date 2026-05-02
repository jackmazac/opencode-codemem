use crate::{
    config::ProjectConfig,
    model::{CloneFingerprint, Evidence, Finding, Severity, Span},
};
use blake3::Hasher;
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};
use xxhash_rust::xxh3::xxh3_64;

#[derive(Debug, Clone)]
pub struct CloneDetector {
    ast_enabled: bool,
    simhash_enabled: bool,
    min_clone_tokens: usize,
    min_clone_statements: usize,
    simhash_radius: u8,
}

impl CloneDetector {
    pub fn new(config: &ProjectConfig) -> Self {
        Self {
            ast_enabled: config.layers.ast_clones,
            simhash_enabled: config.layers.simhash_clones,
            min_clone_tokens: config.thresholds.min_clone_tokens,
            min_clone_statements: config.thresholds.min_clone_statements,
            simhash_radius: config.thresholds.simhash_hamming_radius,
        }
    }

    pub fn analyze_file(
        &self,
        relative_path: &str,
        source: &str,
        generated: bool,
    ) -> Vec<CloneFingerprint> {
        if generated || (!self.ast_enabled && !self.simhash_enabled) {
            return Vec::new();
        }

        extract_function_blocks(source)
            .into_iter()
            .filter_map(|block| self.block_to_fingerprint(relative_path, &block))
            .collect()
    }

    pub fn detect(&self, fingerprints: &[CloneFingerprint], max_findings: usize) -> Vec<Finding> {
        let mut findings = Vec::new();
        if self.ast_enabled {
            findings.extend(self.detect_exact(fingerprints, max_findings));
        }
        if findings.len() >= max_findings {
            findings.truncate(max_findings);
            return findings;
        }
        if self.simhash_enabled {
            findings.extend(self.detect_near_miss(fingerprints, max_findings - findings.len()));
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
        findings.truncate(max_findings);
        findings
    }

    fn detect_exact(&self, fingerprints: &[CloneFingerprint], max_findings: usize) -> Vec<Finding> {
        let mut buckets: BTreeMap<&str, Vec<&CloneFingerprint>> = BTreeMap::new();
        for fingerprint in fingerprints {
            if fingerprint.token_count < self.min_clone_tokens
                || fingerprint.statement_count < self.min_clone_statements
            {
                continue;
            }
            buckets
                .entry(fingerprint.normalized_hash.as_str())
                .or_default()
                .push(fingerprint);
        }

        let mut findings = Vec::new();
        for (hash, bucket) in buckets {
            let unique_symbols = bucket
                .iter()
                .map(|fingerprint| format!("{}::{}", fingerprint.file_path, fingerprint.symbol))
                .collect::<BTreeSet<_>>();
            if unique_symbols.len() < 2 {
                continue;
            }

            let files = bucket
                .iter()
                .map(|fingerprint| fingerprint.file_path.clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            let symbols = bucket
                .iter()
                .map(|fingerprint| format!("{}::{}", fingerprint.file_path, fingerprint.symbol))
                .collect::<Vec<_>>();

            let evidence = bucket
                .iter()
                .take(4)
                .map(|fingerprint| Evidence {
                    kind: "hash".into(),
                    file: Some(fingerprint.file_path.clone()),
                    symbol: Some(fingerprint.symbol.clone()),
                    span: Some(Span {
                        start_line: fingerprint.start_line,
                        start_column: 1,
                        end_line: fingerprint.end_line,
                        end_column: 1,
                    }),
                    detail: format!(
                        "identical normalized subtree hash {} ({} tokens, {} statements)",
                        &fingerprint.normalized_hash[..fingerprint.normalized_hash.len().min(12)],
                        fingerprint.token_count,
                        fingerprint.statement_count
                    ),
                    score: Some(0.99),
                })
                .collect::<Vec<_>>();

            findings.push(Finding::SemanticClone {
                severity: if files.len() > 2 { Severity::Error } else { Severity::Warn },
                confidence: 0.99,
                evidence,
                action: "Merge duplicate implementations behind one canonical helper, then redirect callers.".into(),
                files,
                symbols,
                canonical_hash: Some(hash.to_string()),
                detector: "l1_ast".into(),
                recommendation: "Consolidate one copy and delete the parallel implementation before behavior drifts.".into(),
            });

            if findings.len() >= max_findings {
                break;
            }
        }
        findings
    }

    fn detect_near_miss(
        &self,
        fingerprints: &[CloneFingerprint],
        max_findings: usize,
    ) -> Vec<Finding> {
        if max_findings == 0 {
            return Vec::new();
        }

        let mut bands: BTreeMap<(usize, u16), Vec<usize>> = BTreeMap::new();
        for (index, fingerprint) in fingerprints.iter().enumerate() {
            if fingerprint.token_count < self.min_clone_tokens
                || fingerprint.statement_count < self.min_clone_statements
            {
                continue;
            }
            for (band_index, band_value) in
                band_signatures(fingerprint.simhash).into_iter().enumerate()
            {
                bands
                    .entry((band_index, band_value))
                    .or_default()
                    .push(index);
            }
        }

        let mut seen_pairs = BTreeSet::new();
        let mut findings = Vec::new();
        for candidate_indexes in bands.values() {
            if candidate_indexes.len() < 2 {
                continue;
            }
            for left_position in 0..candidate_indexes.len() {
                for right_position in (left_position + 1)..candidate_indexes.len() {
                    let left_index = candidate_indexes[left_position];
                    let right_index = candidate_indexes[right_position];
                    let pair = if left_index <= right_index {
                        (left_index, right_index)
                    } else {
                        (right_index, left_index)
                    };
                    if !seen_pairs.insert(pair) {
                        continue;
                    }
                    let left = &fingerprints[pair.0];
                    let right = &fingerprints[pair.1];
                    if left.normalized_hash == right.normalized_hash {
                        continue;
                    }
                    if left.file_path == right.file_path && left.symbol == right.symbol {
                        continue;
                    }
                    let hamming = hamming_distance(left.simhash, right.simhash);
                    if hamming > self.simhash_radius {
                        continue;
                    }
                    let token_similarity =
                        jaccard_similarity(&left.normalized_tokens, &right.normalized_tokens);
                    let token_count_ratio = ratio(left.token_count, right.token_count);
                    if token_similarity < 0.72 || token_count_ratio < 0.6 {
                        continue;
                    }
                    let confidence =
                        ((1.0 - (hamming as f64 / 64.0)) * 0.55) + (token_similarity * 0.45);
                    if confidence < 0.78 {
                        continue;
                    }

                    findings.push(Finding::SemanticClone {
                        severity: Severity::Warn,
                        confidence,
                        evidence: vec![
                            Evidence {
                                kind: "hash".into(),
                                file: Some(left.file_path.clone()),
                                symbol: Some(left.symbol.clone()),
                                span: Some(Span {
                                    start_line: left.start_line,
                                    start_column: 1,
                                    end_line: left.end_line,
                                    end_column: 1,
                                }),
                                detail: format!(
                                    "simhash within radius {} (distance={}, tokenJaccard={:.2})",
                                    self.simhash_radius, hamming, token_similarity
                                ),
                                score: Some(confidence),
                            },
                            Evidence {
                                kind: "token_profile".into(),
                                file: Some(right.file_path.clone()),
                                symbol: Some(right.symbol.clone()),
                                span: Some(Span {
                                    start_line: right.start_line,
                                    start_column: 1,
                                    end_line: right.end_line,
                                    end_column: 1,
                                }),
                                detail: format!(
                                    "normalized token profile overlaps strongly (ratio={:.2}, {} vs {} tokens)",
                                    token_count_ratio, left.token_count, right.token_count
                                ),
                                score: Some(confidence),
                            },
                        ],
                        action: "Inspect both implementations and extract a shared helper or delete the weaker copy.".into(),
                        files: vec![left.file_path.clone(), right.file_path.clone()],
                        symbols: vec![
                            format!("{}::{}", left.file_path, left.symbol),
                            format!("{}::{}", right.file_path, right.symbol),
                        ],
                        canonical_hash: None,
                        detector: "l2_simhash".into(),
                        recommendation: "Review behavior-level overlap before the copies diverge further.".into(),
                    });
                    if findings.len() >= max_findings {
                        return findings;
                    }
                }
            }
        }
        findings
    }

    fn block_to_fingerprint(
        &self,
        relative_path: &str,
        block: &FunctionBlock,
    ) -> Option<CloneFingerprint> {
        let normalized_tokens = normalize_tokens(&block.body);
        let statement_count = count_statements(&block.body);
        if normalized_tokens.len() < self.min_clone_tokens
            || statement_count < self.min_clone_statements
        {
            return None;
        }
        let normalized_hash = hash_tokens(&normalized_tokens);
        let simhash = compute_simhash(&normalized_tokens);
        Some(CloneFingerprint {
            file_path: relative_path.to_string(),
            symbol: block.symbol.clone(),
            kind: block.kind.clone(),
            start_line: block.start_line,
            end_line: block.end_line,
            normalized_hash,
            simhash,
            token_count: normalized_tokens.len(),
            statement_count,
            normalized_tokens,
        })
    }
}

#[derive(Debug, Clone)]
struct FunctionBlock {
    symbol: String,
    kind: String,
    start_line: u32,
    end_line: u32,
    body: String,
}

fn extract_function_blocks(source: &str) -> Vec<FunctionBlock> {
    let patterns = [
        (Regex::new(r"(?m)^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(").unwrap(), "function"),
        (Regex::new(r"(?m)^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=\s*(?:async\s+)?\([^\n]*?\)\s*=>\s*\{").unwrap(), "arrow"),
        (Regex::new(r"(?m)^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=\s*(?:async\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=>\s*\{").unwrap(), "arrow"),
    ];

    let mut blocks = Vec::new();
    let mut seen_starts = BTreeSet::new();
    for (regex, kind) in patterns {
        for captures in regex.captures_iter(source) {
            let Some(whole) = captures.get(0) else {
                continue;
            };
            let Some(name) = captures.get(1) else {
                continue;
            };
            let body_start = source[whole.start()..]
                .find('{')
                .map(|offset| whole.start() + offset);
            let Some(body_start) = body_start else {
                continue;
            };
            if !seen_starts.insert(body_start) {
                continue;
            }
            let Some(body_end) = match_brace(source, body_start) else {
                continue;
            };
            let body = source[body_start..=body_end].to_string();
            let start_line = byte_offset_to_line(source, whole.start());
            let end_line = byte_offset_to_line(source, body_end);
            blocks.push(FunctionBlock {
                symbol: name.as_str().to_string(),
                kind: kind.to_string(),
                start_line,
                end_line,
                body,
            });
        }
    }
    blocks
}

fn byte_offset_to_line(source: &str, offset: usize) -> u32 {
    (source[..offset.min(source.len())]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count()
        + 1) as u32
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

fn normalize_tokens(source: &str) -> Vec<String> {
    let token_regex = Regex::new(
        r#"[A-Za-z_][A-Za-z0-9_]*|0x[0-9A-Fa-f]+|\d+(?:\.\d+)?|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|===|!==|==|!=|<=|>=|=>|&&|\|\||\?\?|\+\+|--|\.\.\.|[{}()\[\].,;:+\-*/%<>=!?&|^~]"#,
    )
    .unwrap();
    let keywords = [
        "if",
        "else",
        "for",
        "while",
        "switch",
        "case",
        "return",
        "throw",
        "await",
        "async",
        "try",
        "catch",
        "finally",
        "break",
        "continue",
        "new",
        "typeof",
        "instanceof",
        "in",
        "of",
        "function",
        "const",
        "let",
        "var",
        "class",
        "extends",
        "implements",
        "import",
        "export",
        "default",
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();

    let mut tokens = Vec::new();
    for token in token_regex.find_iter(source).map(|match_| match_.as_str()) {
        let normalized =
            if token.starts_with('"') || token.starts_with('\'') || token.starts_with('`') {
                "LIT".to_string()
            } else if token.chars().next().is_some_and(|ch| ch.is_ascii_digit())
                || token.starts_with("0x")
            {
                "LIT".to_string()
            } else if token
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_')
            {
                if keywords.contains(token) {
                    token.to_string()
                } else {
                    "ID".to_string()
                }
            } else {
                token.to_string()
            };
        tokens.push(normalized);
    }
    tokens
}

fn count_statements(source: &str) -> usize {
    let keyword_regex = Regex::new(r"\b(if|for|while|switch|return|throw|await|yield)\b").unwrap();
    let semicolons = source.bytes().filter(|byte| *byte == b';').count();
    let keyword_count = keyword_regex.find_iter(source).count();
    semicolons + keyword_count.max(1)
}

fn hash_tokens(tokens: &[String]) -> String {
    let mut hasher = Hasher::new();
    for token in tokens {
        hasher.update(token.as_bytes());
        hasher.update(b"\0");
    }
    hasher.finalize().to_hex().to_string()
}

fn compute_simhash(tokens: &[String]) -> u64 {
    let shingles = if tokens.len() >= 5 {
        tokens
            .windows(5)
            .map(|window| window.join(" "))
            .collect::<Vec<_>>()
    } else {
        vec![tokens.join(" ")]
    };

    let mut accum = [0i64; 64];
    for shingle in shingles {
        let hash = xxh3_64(shingle.as_bytes());
        for (bit_index, slot) in accum.iter_mut().enumerate() {
            if (hash >> bit_index) & 1 == 1 {
                *slot += 1;
            } else {
                *slot -= 1;
            }
        }
    }

    let mut result = 0u64;
    for (bit_index, weight) in accum.iter().enumerate() {
        if *weight >= 0 {
            result |= 1u64 << bit_index;
        }
    }
    result
}

fn band_signatures(simhash: u64) -> [u16; 4] {
    [
        (simhash & 0xFFFF) as u16,
        ((simhash >> 16) & 0xFFFF) as u16,
        ((simhash >> 32) & 0xFFFF) as u16,
        ((simhash >> 48) & 0xFFFF) as u16,
    ]
}

fn hamming_distance(left: u64, right: u64) -> u8 {
    (left ^ right).count_ones() as u8
}

fn jaccard_similarity(left: &[String], right: &[String]) -> f64 {
    let left_set = left.iter().collect::<BTreeSet<_>>();
    let right_set = right.iter().collect::<BTreeSet<_>>();
    let intersection = left_set.intersection(&right_set).count();
    let union = left_set.union(&right_set).count();
    if union == 0 {
        return 0.0;
    }
    intersection as f64 / union as f64
}

fn ratio(left: usize, right: usize) -> f64 {
    if left == 0 || right == 0 {
        return 0.0;
    }
    let min = left.min(right) as f64;
    let max = left.max(right) as f64;
    min / max
}
