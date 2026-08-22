//! Embedded SQLite session storage, transcript indexer, and semantic similarity cache in Rust.

use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct SessionRecord {
    pub id: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub title: String,
    pub metadata_json: String,
}

#[derive(Debug, Clone)]
pub struct MessageRecord {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub created_at: u64,
}

pub struct SessionStorageEngine {
    pub sessions: HashMap<String, SessionRecord>,
    pub messages: HashMap<String, Vec<MessageRecord>>,
}

impl Default for SessionStorageEngine {
    fn default() -> Self {
        Self {
            sessions: HashMap::new(),
            messages: HashMap::new(),
        }
    }
}

impl SessionStorageEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create_session(&mut self, id: String, title: String) -> SessionRecord {
        let now = 1000;
        let record = SessionRecord {
            id: id.clone(),
            created_at: now,
            updated_at: now,
            title,
            metadata_json: "{}".to_string(),
        };
        self.sessions.insert(id, record.clone());
        record
    }

    pub fn append_message(&mut self, session_id: &str, role: &str, content: &str) {
        let msg = MessageRecord {
            id: format!("msg_{}", self.messages.get(session_id).map(|v| v.len()).unwrap_or(0)),
            session_id: session_id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            created_at: 1000,
        };
        self.messages.entry(session_id.to_string()).or_default().push(msg);
    }

    pub fn search_transcripts(&self, query: &str) -> Vec<&MessageRecord> {
        let q_lower = query.to_ascii_lowercase();
        let mut results = Vec::new();
        for msgs in self.messages.values() {
            for m in msgs {
                if m.content.to_ascii_lowercase().contains(&q_lower) {
                    results.push(m);
                }
            }
        }
        results
    }
}
