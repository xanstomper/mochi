//! Project Memory, Lessons Learned, and Vector Semantic Store in Rust.

use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct MemoryItem {
    pub key: String,
    pub content: String,
    pub score: f32,
    pub created_at: u64,
}

pub struct MemoryIndex {
    pub items: HashMap<String, MemoryItem>,
}

impl Default for MemoryIndex {
    fn default() -> Self {
        Self {
            items: HashMap::new(),
        }
    }
}

impl MemoryIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&mut self, key: String, content: String) {
        self.items.insert(
            key.clone(),
            MemoryItem {
                key,
                content,
                score: 1.0,
                created_at: 1000,
            },
        );
    }

    pub fn get(&self, key: &str) -> Option<&MemoryItem> {
        self.items.get(key)
    }

    pub fn search(&self, query: &str) -> Vec<&MemoryItem> {
        let q = query.to_ascii_lowercase();
        self.items
            .values()
            .filter(|item| item.key.to_ascii_lowercase().contains(&q) || item.content.to_ascii_lowercase().contains(&q))
            .collect()
    }
}
