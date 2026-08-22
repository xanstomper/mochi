//! Symbol Hierarchy, Type Definition Locator, and Call Graph Analyzer in Rust.

use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct SymbolNode {
    pub name: String,
    pub kind: String,
    pub parent: Option<String>,
    pub children: Vec<String>,
}

pub struct SymbolHierarchy {
    pub nodes: HashMap<String, SymbolNode>,
}

impl Default for SymbolHierarchy {
    fn default() -> Self {
        Self {
            nodes: HashMap::new(),
        }
    }
}

impl SymbolHierarchy {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert_symbol(&mut self, name: String, kind: String, parent: Option<String>) {
        let node = SymbolNode {
            name: name.clone(),
            kind,
            parent: parent.clone(),
            children: Vec::new(),
        };
        self.nodes.insert(name.clone(), node);

        if let Some(p_name) = parent {
            if let Some(p_node) = self.nodes.get_mut(&p_name) {
                p_node.children.push(name);
            }
        }
    }
}
