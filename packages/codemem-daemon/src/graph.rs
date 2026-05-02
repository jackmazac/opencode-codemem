use crate::{
    config::{PackageBoundary, ProjectConfig},
    model::{DriftMapAssembly, DriftMapNode, Evidence, Finding, ImportEdge, Severity},
    store::Store,
};
use anyhow::Result;
use globset::Glob;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;

#[derive(Debug, Clone)]
pub struct ModuleGraph {
    entrypoints: Vec<String>,
    imports_from: BTreeMap<String, Vec<ImportEdge>>,
    imports_to: BTreeMap<String, Vec<ImportEdge>>,
    package_boundaries: Vec<PackageBoundary>,
    all_files: BTreeSet<String>,
}

impl ModuleGraph {
    pub fn load(project_root: &Path, config: &ProjectConfig, store: &Store) -> Result<Self> {
        let all_files = store.all_files()?.into_iter().collect::<BTreeSet<_>>();
        let entrypoints = expand_entrypoints(&all_files, &config.entrypoints);
        let mut imports_from: BTreeMap<String, Vec<ImportEdge>> = BTreeMap::new();
        let mut imports_to: BTreeMap<String, Vec<ImportEdge>> = BTreeMap::new();
        for edge in store.load_import_edges()? {
            imports_from
                .entry(edge.from_path.clone())
                .or_default()
                .push(edge.clone());
            if let Some(target) = &edge.to_path {
                imports_to.entry(target.clone()).or_default().push(edge);
            }
        }

        let _ = project_root;
        Ok(Self {
            entrypoints,
            imports_from,
            imports_to,
            package_boundaries: config.package_boundaries.clone(),
            all_files,
        })
    }

    pub fn reachable_files(&self) -> BTreeSet<String> {
        self.forward_closure(&self.entrypoints, usize::MAX)
    }

    pub fn dependency_cone(&self, seeds: &[String], depth: usize) -> BTreeSet<String> {
        let mut visited = BTreeSet::new();
        let mut queue = VecDeque::new();
        for seed in seeds {
            if self.all_files.contains(seed) {
                visited.insert(seed.clone());
                queue.push_back((seed.clone(), 0usize));
            }
        }

        while let Some((current, current_depth)) = queue.pop_front() {
            if current_depth >= depth {
                continue;
            }
            for next in self.forward_neighbors(&current) {
                if visited.insert(next.clone()) {
                    queue.push_back((next, current_depth + 1));
                }
            }
            for next in self.reverse_neighbors(&current) {
                if visited.insert(next.clone()) {
                    queue.push_back((next, current_depth + 1));
                }
            }
        }

        visited
    }

    pub fn reverse_dependents_of(&self, seed: &str, limit: usize) -> Vec<String> {
        let mut visited = BTreeSet::new();
        let mut queue = VecDeque::from([seed.to_string()]);
        while let Some(current) = queue.pop_front() {
            for next in self.reverse_neighbors(&current) {
                if visited.insert(next.clone()) && visited.len() < limit {
                    queue.push_back(next);
                }
            }
            if visited.len() >= limit {
                break;
            }
        }
        visited.into_iter().collect()
    }

    pub fn dynamic_import_risk_for(&self, file: &str) -> bool {
        self.imports_to
            .get(file)
            .into_iter()
            .flatten()
            .any(|edge| edge.is_dynamic)
    }

    pub fn cycle_findings(&self, max_findings: usize) -> Vec<Finding> {
        let mut findings = Vec::new();
        for component in tarjan_scc(&self.file_dependency_graph()) {
            if component.len() < 2 {
                continue;
            }
            findings.push(Finding::Cycle {
                severity: if component.len() > 3 { Severity::Error } else { Severity::Warn },
                confidence: 0.95,
                evidence: component
                    .iter()
                    .map(|node| Evidence {
                        kind: "graph_edge".into(),
                        file: Some(node.clone()),
                        symbol: None,
                        span: None,
                        detail: "module participates in strongly connected component".into(),
                        score: Some(0.95),
                    })
                    .collect(),
                action: "Break the cycle by extracting an interface boundary or relocating shared contracts to a lower layer.".into(),
                nodes: component,
                package_level: false,
            });
            if findings.len() >= max_findings {
                return findings;
            }
        }

        findings.extend(self.package_cycle_findings(max_findings.saturating_sub(findings.len())));

        findings
    }

    pub fn package_cycle_findings(&self, max_findings: usize) -> Vec<Finding> {
        if max_findings == 0 {
            return Vec::new();
        }
        let mut findings = Vec::new();
        for component in self.package_cycles() {
            if component.len() < 2 {
                continue;
            }
            findings.push(Finding::Cycle {
                severity: Severity::Error,
                confidence: 0.98,
                evidence: component
                    .iter()
                    .map(|node| Evidence {
                        kind: "graph_edge".into(),
                        file: Some(node.clone()),
                        symbol: None,
                        span: None,
                        detail: "package boundary cycle detected".into(),
                        score: Some(0.98),
                    })
                    .collect(),
                action: "Reassign ownership so package dependencies flow in one direction only."
                    .into(),
                nodes: component,
                package_level: true,
            });
            if findings.len() >= max_findings {
                break;
            }
        }

        findings
    }

    pub fn dead_code_findings(&self, store: &Store, max_findings: usize) -> Result<Vec<Finding>> {
        let reachable = self.reachable_files();
        let exports = store.load_public_exports()?;
        let mut findings = Vec::new();
        for export in exports {
            if reachable.contains(&export.source_file) {
                continue;
            }
            let dynamic_risk = self.dynamic_import_risk_for(&export.source_file);
            findings.push(Finding::DeadCode {
                severity: if dynamic_risk { Severity::Info } else { Severity::Warn },
                confidence: if dynamic_risk { 0.55 } else { 0.86 },
                evidence: vec![Evidence {
                    kind: if dynamic_risk { "dynamic_import".into() } else { "graph_edge".into() },
                    file: Some(export.source_file.clone()),
                    symbol: Some(export.export_name.clone()),
                    span: None,
                    detail: if dynamic_risk {
                        "export is not reachable from declared entrypoints, but there is dynamic-import activity near this file".into()
                    } else {
                        "export is unreachable from declared entrypoints and has no observed inbound edges".into()
                    },
                    score: Some(if dynamic_risk { 0.55 } else { 0.86 }),
                }],
                action: "Delete the export, move it behind a lazy boundary, or add the real entrypoint to codemem config.".into(),
                symbol: export.export_name,
                file: export.source_file,
                reason: "unreachable_from_entrypoints".into(),
                dynamic_import_risk: dynamic_risk,
            });
            if findings.len() >= max_findings {
                break;
            }
        }
        Ok(findings)
    }

    pub fn api_drift_findings(&self, store: &Store, max_findings: usize) -> Result<Vec<Finding>> {
        let current = store.load_public_exports()?;
        let baseline = store.read_api_baseline()?;
        if baseline.is_empty() {
            return Ok(Vec::new());
        }

        let mut current_map = BTreeMap::new();
        for export in current {
            current_map.insert(
                (export.export_name.clone(), export.source_file.clone()),
                export.signature,
            );
        }

        let mut findings = Vec::new();
        for ((export_name, source_file), before) in &baseline {
            match current_map.get(&(export_name.clone(), source_file.clone())) {
                Some(after) if after != before => {
                    findings.push(Finding::ApiDrift {
                        severity: Severity::Error,
                        confidence: 0.97,
                        evidence: vec![
                            Evidence {
                                kind: "signature".into(),
                                file: Some(source_file.clone()),
                                symbol: Some(export_name.clone()),
                                span: None,
                                detail: format!("baseline signature: {before}"),
                                score: Some(0.97),
                            },
                            Evidence {
                                kind: "signature".into(),
                                file: Some(source_file.clone()),
                                symbol: Some(export_name.clone()),
                                span: None,
                                detail: format!("current signature: {after}"),
                                score: Some(0.97),
                            },
                        ],
                        action: "Update callers, add compatibility shims, or refresh the API baseline intentionally.".into(),
                        export_name: export_name.clone(),
                        source_file: source_file.clone(),
                        before: before.clone(),
                        after: after.clone(),
                        affected_callers: self.reverse_dependents_of(source_file, 12),
                    });
                }
                None => {
                    findings.push(Finding::ApiDrift {
                        severity: Severity::Error,
                        confidence: 0.98,
                        evidence: vec![Evidence {
                            kind: "signature".into(),
                            file: Some(source_file.clone()),
                            symbol: Some(export_name.clone()),
                            span: None,
                            detail: format!("baseline export removed: {before}"),
                            score: Some(0.98),
                        }],
                        action: "Restore the export, add a migration path, or intentionally refresh baseline after updating dependents.".into(),
                        export_name: export_name.clone(),
                        source_file: source_file.clone(),
                        before: before.clone(),
                        after: "<removed>".into(),
                        affected_callers: self.reverse_dependents_of(source_file, 12),
                    });
                }
                _ => {}
            }
            if findings.len() >= max_findings {
                return Ok(findings);
            }
        }
        Ok(findings)
    }

    pub fn ensure_api_baseline(&self, store: &Store) -> Result<bool> {
        let baseline = store.read_api_baseline()?;
        if !baseline.is_empty() {
            return Ok(false);
        }
        let exports = store.load_public_exports()?;
        if exports.is_empty() {
            return Ok(false);
        }
        store.write_api_baseline(&exports, "bootstrap")?;
        Ok(true)
    }

    pub fn drift_map(&self, findings: Vec<Finding>) -> DriftMapAssembly {
        let mut map = DriftMapAssembly::default();
        for finding in &findings {
            match finding {
                Finding::SemanticClone {
                    files,
                    symbols,
                    severity,
                    ..
                } => {
                    for file in files {
                        map.insert_node(DriftMapNode {
                            id: format!("file:{file}"),
                            label: file.clone(),
                            kind: "file".into(),
                            severity: Some(*severity),
                        });
                    }
                    if files.len() >= 2 {
                        map.insert_edge(
                            format!("file:{}", files[0]),
                            format!("file:{}", files[1]),
                            "duplicates".into(),
                            false,
                        );
                    }
                    for symbol in symbols {
                        map.insert_node(DriftMapNode {
                            id: format!("type:{symbol}"),
                            label: symbol.clone(),
                            kind: "type".into(),
                            severity: Some(*severity),
                        });
                    }
                }
                Finding::TypeShapeDuplicate {
                    symbols, severity, ..
                } => {
                    for symbol in symbols {
                        map.insert_node(DriftMapNode {
                            id: format!("type:{symbol}"),
                            label: symbol.clone(),
                            kind: "type".into(),
                            severity: Some(*severity),
                        });
                    }
                    if symbols.len() >= 2 {
                        map.insert_edge(
                            format!("type:{}", symbols[0]),
                            format!("type:{}", symbols[1]),
                            "duplicates".into(),
                            false,
                        );
                    }
                }
                Finding::ApiDrift {
                    source_file,
                    export_name,
                    affected_callers,
                    severity,
                    ..
                } => {
                    map.insert_node(DriftMapNode {
                        id: format!("file:{source_file}"),
                        label: source_file.clone(),
                        kind: "file".into(),
                        severity: Some(*severity),
                    });
                    let export_id = format!("export:{source_file}:{export_name}");
                    map.insert_node(DriftMapNode {
                        id: export_id.clone(),
                        label: export_name.clone(),
                        kind: "export".into(),
                        severity: Some(*severity),
                    });
                    map.insert_edge(
                        format!("file:{source_file}"),
                        export_id.clone(),
                        "exports".into(),
                        false,
                    );
                    for caller in affected_callers {
                        map.insert_node(DriftMapNode {
                            id: format!("file:{caller}"),
                            label: caller.clone(),
                            kind: "file".into(),
                            severity: None,
                        });
                        map.insert_edge(
                            format!("file:{caller}"),
                            export_id.clone(),
                            "depends_on".into(),
                            false,
                        );
                    }
                }
                Finding::DeadCode { file, severity, .. } => {
                    map.insert_node(DriftMapNode {
                        id: format!("file:{file}"),
                        label: file.clone(),
                        kind: "file".into(),
                        severity: Some(*severity),
                    });
                }
                Finding::Cycle {
                    nodes,
                    package_level,
                    severity,
                    ..
                } => {
                    let kind = if *package_level { "package" } else { "file" };
                    for node in nodes {
                        map.insert_node(DriftMapNode {
                            id: format!("{kind}:{node}"),
                            label: node.clone(),
                            kind: kind.into(),
                            severity: Some(*severity),
                        });
                    }
                    for pair in nodes.windows(2) {
                        map.insert_edge(
                            format!("{kind}:{}", pair[0]),
                            format!("{kind}:{}", pair[1]),
                            "imports".into(),
                            false,
                        );
                    }
                }
                Finding::SessionConflict {
                    sessions,
                    touched_cone,
                    severity,
                    ..
                } => {
                    for session in sessions {
                        map.insert_node(DriftMapNode {
                            id: format!("session:{session}"),
                            label: session.clone(),
                            kind: "session".into(),
                            severity: Some(*severity),
                        });
                    }
                    for file in touched_cone {
                        map.insert_node(DriftMapNode {
                            id: format!("file:{file}"),
                            label: file.clone(),
                            kind: "file".into(),
                            severity: None,
                        });
                    }
                }
            }
        }

        for (from, edges) in &self.imports_from {
            let from_id = format!("file:{from}");
            if !map.nodes.contains_key(&from_id) {
                continue;
            }
            for edge in edges {
                if let Some(to) = &edge.to_path {
                    let to_id = format!("file:{to}");
                    if map.nodes.contains_key(&to_id) {
                        map.insert_edge(from_id.clone(), to_id, "imports".into(), edge.is_dynamic);
                    }
                }
            }
        }

        map
    }

    fn forward_neighbors(&self, node: &str) -> Vec<String> {
        self.imports_from
            .get(node)
            .into_iter()
            .flatten()
            .filter_map(|edge| edge.to_path.clone())
            .collect()
    }

    fn reverse_neighbors(&self, node: &str) -> Vec<String> {
        self.imports_to
            .get(node)
            .into_iter()
            .flatten()
            .map(|edge| edge.from_path.clone())
            .collect()
    }

    fn forward_closure(&self, seeds: &[String], max_depth: usize) -> BTreeSet<String> {
        let mut visited = BTreeSet::new();
        let mut queue = VecDeque::new();
        for seed in seeds {
            if self.all_files.contains(seed) {
                visited.insert(seed.clone());
                queue.push_back((seed.clone(), 0usize));
            }
        }

        while let Some((current, depth)) = queue.pop_front() {
            if depth >= max_depth {
                continue;
            }
            for next in self.forward_neighbors(&current) {
                if visited.insert(next.clone()) {
                    queue.push_back((next, depth + 1));
                }
            }
        }
        visited
    }

    fn package_cycles(&self) -> Vec<Vec<String>> {
        let mut graph: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (from, edges) in &self.imports_from {
            let Some(from_package) = self.package_id(from) else {
                continue;
            };
            for edge in edges {
                let Some(target) = edge.to_path.as_ref() else {
                    continue;
                };
                let Some(to_package) = self.package_id(target) else {
                    continue;
                };
                if from_package != to_package {
                    graph
                        .entry(from_package.clone())
                        .or_default()
                        .push(to_package);
                }
            }
        }
        tarjan_scc(&graph)
    }

    fn file_dependency_graph(&self) -> BTreeMap<String, Vec<String>> {
        self.imports_from
            .iter()
            .map(|(from, edges)| {
                let targets = edges
                    .iter()
                    .filter_map(|edge| edge.to_path.clone())
                    .collect::<Vec<_>>();
                (from.clone(), targets)
            })
            .collect()
    }

    fn package_id(&self, file: &str) -> Option<String> {
        for boundary in &self.package_boundaries {
            let Ok(glob) = Glob::new(&boundary.root) else {
                continue;
            };
            let matcher = glob.compile_matcher();
            if matcher.is_match(file) {
                return Some(
                    boundary
                        .name
                        .clone()
                        .unwrap_or_else(|| boundary.root.clone()),
                );
            }
        }
        None
    }
}

fn expand_entrypoints(all_files: &BTreeSet<String>, patterns: &[String]) -> Vec<String> {
    if patterns.is_empty() {
        return all_files.iter().take(1).cloned().collect();
    }
    let mut entrypoints = Vec::new();
    for pattern in patterns {
        if pattern.contains('*') || pattern.contains('?') || pattern.contains('[') {
            let Ok(glob) = Glob::new(pattern) else {
                continue;
            };
            let matcher = glob.compile_matcher();
            entrypoints.extend(
                all_files
                    .iter()
                    .filter(|file| matcher.is_match(file.as_str()))
                    .cloned(),
            );
        } else if all_files.contains(pattern) {
            entrypoints.push(pattern.clone());
        }
    }
    entrypoints.sort();
    entrypoints.dedup();
    entrypoints
}

fn tarjan_scc(graph: &BTreeMap<String, Vec<String>>) -> Vec<Vec<String>> {
    struct Tarjan<'a> {
        graph: &'a BTreeMap<String, Vec<String>>,
        index: usize,
        stack: Vec<String>,
        on_stack: BTreeSet<String>,
        indices: BTreeMap<String, usize>,
        lowlinks: BTreeMap<String, usize>,
        components: Vec<Vec<String>>,
    }

    impl<'a> Tarjan<'a> {
        fn strong_connect(&mut self, node: String) {
            let current_index = self.index;
            self.indices.insert(node.clone(), current_index);
            self.lowlinks.insert(node.clone(), current_index);
            self.index += 1;
            self.stack.push(node.clone());
            self.on_stack.insert(node.clone());

            for next in self.graph.get(&node).cloned().unwrap_or_default() {
                if !self.indices.contains_key(&next) {
                    self.strong_connect(next.clone());
                    let lowlink = self.lowlinks.get(&node).copied().unwrap_or(current_index);
                    let next_lowlink = self.lowlinks.get(&next).copied().unwrap_or(current_index);
                    self.lowlinks
                        .insert(node.clone(), lowlink.min(next_lowlink));
                } else if self.on_stack.contains(&next) {
                    let lowlink = self.lowlinks.get(&node).copied().unwrap_or(current_index);
                    let next_index = self.indices.get(&next).copied().unwrap_or(current_index);
                    self.lowlinks.insert(node.clone(), lowlink.min(next_index));
                }
            }

            if self.lowlinks.get(&node) == self.indices.get(&node) {
                let mut component = Vec::new();
                while let Some(popped) = self.stack.pop() {
                    self.on_stack.remove(&popped);
                    component.push(popped.clone());
                    if popped == node {
                        break;
                    }
                }
                component.sort();
                self.components.push(component);
            }
        }
    }

    let mut tarjan = Tarjan {
        graph,
        index: 0,
        stack: Vec::new(),
        on_stack: BTreeSet::new(),
        indices: BTreeMap::new(),
        lowlinks: BTreeMap::new(),
        components: Vec::new(),
    };

    let nodes = graph
        .keys()
        .cloned()
        .chain(graph.values().flat_map(|values| values.iter().cloned()))
        .collect::<BTreeSet<_>>();
    for node in nodes {
        if !tarjan.indices.contains_key(&node) {
            tarjan.strong_connect(node);
        }
    }
    tarjan.components
}
