//! Context Manager, Token Window Packing, and Memory Truncator in Rust.

use crate::agent_loop::Message;

pub struct ContextManager {
    pub max_context_tokens: usize,
    pub reserved_output_tokens: usize,
    pub system_tokens: usize,
}

impl Default for ContextManager {
    fn default() -> Self {
        Self {
            max_context_tokens: 128_000,
            reserved_output_tokens: 4_096,
            system_tokens: 2_048,
        }
    }
}

impl ContextManager {
    pub fn new(max_tokens: usize) -> Self {
        Self {
            max_context_tokens: max_tokens,
            ..Default::default()
        }
    }

    pub fn estimate_message_tokens(msg: &Message) -> usize {
        let content_len = msg.content.len();
        let tool_len: usize = msg
            .tool_calls
            .iter()
            .map(|t| t.name.len() + t.arguments.len() + 20)
            .sum();
        (content_len + tool_len + 16) / 4
    }

    pub fn prune_messages(&self, messages: &[Message]) -> Vec<Message> {
        let budget = self.max_context_tokens.saturating_sub(self.reserved_output_tokens);
        let mut total_tokens = 0usize;
        let mut keep = Vec::new();

        // Always keep system prompt (first message)
        let has_system = messages.first().map(|m| m.role == "system").unwrap_or(false);
        let start_idx = if has_system { 1 } else { 0 };

        // Walk backwards from most recent messages
        for msg in messages[start_idx..].iter().rev() {
            let tokens = Self::estimate_message_tokens(msg);
            if total_tokens + tokens > budget && !keep.is_empty() {
                break;
            }
            total_tokens += tokens;
            keep.push(msg.clone());
        }

        keep.reverse();

        if has_system {
            let mut result = Vec::with_capacity(keep.len() + 1);
            result.push(messages[0].clone());
            result.extend(keep);
            result
        } else {
            keep
        }
    }

    /// VALID CUT POINTS (mirrors the TS ContextEngine invariant): never cut
    /// between an assistant tool_call message and its tool results. Given the
    /// full transcript and a recency window, returns the index at which the
    /// older history may be dropped such that the kept suffix starts at a
    /// valid boundary (user/system message, or an assistant message with no
    /// pending tool_calls). Returns None when nothing should be dropped.
    pub fn plan_compaction_cut(&self, messages: &[Message], keep_window: usize) -> Option<usize> {
        if messages.len() <= keep_window {
            return None;
        }
        let target = messages.len() - keep_window;
        let mut cut = target;
        while cut < messages.len() - 1 {
            let m = &messages[cut];
            let valid = match m.role.as_str() {
                "user" | "system" => true,
                "assistant" => m.tool_calls.is_empty(),
                _ => false, // never cut AT a tool result
            };
            if valid {
                break;
            }
            cut += 1;
        }
        if cut == 0 {
            None
        } else {
            Some(cut)
        }
    }
}
