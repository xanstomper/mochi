//! CodeGraph & Symbol Resolution Engine in Rust.
//! Analyzes AST structures, imports, exports, and function references across project files.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

#[derive(Debug, Clone)]
pub struct Symbol {
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: usize,
    pub exported: bool,
}

#[derive(Debug, Default)]
pub struct CodeGraph {
    pub symbols: Vec<Symbol>,
    pub file_symbols: HashMap<String, Vec<usize>>,
    pub imports: HashMap<String, HashSet<String>>,
    pub exports: HashMap<String, HashSet<String>>,
}

impl CodeGraph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn index_file(&mut self, root: &Path, file_path: &Path) -> Result<(), std::io::Error> {
        let file = File::open(file_path)?;
        let reader = BufReader::new(file);
        let rel_path = file_path
            .strip_prefix(root)
            .unwrap_or(file_path)
            .to_string_lossy()
            .to_string();

        let mut line_num = 0;
        for line in reader.lines().flatten() {
            line_num += 1;
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') {
                continue;
            }

            // Check imports
            if trimmed.starts_with("import ") || trimmed.starts_with("use ") || trimmed.starts_with("from ") {
                self.imports
                    .entry(rel_path.clone())
                    .or_default()
                    .insert(trimmed.to_string());
            }

            // Check declarations
            let is_export = trimmed.starts_with("export ") || trimmed.starts_with("pub ");
            let decl = if is_export {
                trimmed.strip_prefix("export ").or_else(|| trimmed.strip_prefix("pub ")).unwrap_or(trimmed).trim()
            } else {
                trimmed
            };

            let kind_and_name = if decl.starts_with("function ") || decl.starts_with("async function ") {
                let name = decl.split_whitespace().nth(if decl.starts_with("async") { 2 } else { 1 })
                    .and_then(|s| s.split('(').next());
                name.map(|n| ("function", n))
            } else if decl.starts_with("class ") || decl.starts_with("struct ") {
                let name = decl.split_whitespace().nth(1).and_then(|s| s.split('{').next());
                name.map(|n| ("class", n))
            } else if decl.starts_with("interface ") || decl.starts_with("trait ") {
                let name = decl.split_whitespace().nth(1).and_then(|s| s.split('{').next());
                name.map(|n| ("interface", n))
            } else if decl.starts_with("enum ") {
                let name = decl.split_whitespace().nth(1).and_then(|s| s.split('{').next());
                name.map(|n| ("enum", n))
            } else if decl.starts_with("type ") {
                let name = decl.split_whitespace().nth(1).and_then(|s| s.split('=').next());
                name.map(|n| ("type", n))
            } else if decl.starts_with("const ") && decl.contains(" = ") {
                let name = decl.split_whitespace().nth(1).and_then(|s| s.split(':').next()).and_then(|s| s.split('=').next());
                name.map(|n| ("const", n))
            } else if decl.starts_with("fn ") || decl.starts_with("def ") {
                let name = decl.split_whitespace().nth(1).and_then(|s| s.split('(').next());
                name.map(|n| ("function", n))
            } else {
                None
            };

            if let Some((kind, name)) = kind_and_name {
                let clean_name = name.trim().trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
                if !clean_name.is_empty() {
                    let sym_idx = self.symbols.len();
                    self.symbols.push(Symbol {
                        name: clean_name.to_string(),
                        kind: kind.to_string(),
                        file: rel_path.clone(),
                        line: line_num,
                        exported: is_export,
                    });
                    self.file_symbols
                        .entry(rel_path.clone())
                        .or_default()
                        .push(sym_idx);

                    if is_export {
                        self.exports
                            .entry(rel_path.clone())
                            .or_default()
                            .insert(clean_name.to_string());
                    }
                }
            }
        }

        Ok(())
    }

    pub fn find_symbol(&self, query: &str) -> Vec<&Symbol> {
        let q_lower = query.to_ascii_lowercase();
        self.symbols
            .iter()
            .filter(|s| s.name.to_ascii_lowercase().contains(&q_lower))
            .collect()
    }
}
