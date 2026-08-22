//! Full Agent Loop State Machine & Orchestrator in Rust.
//! Manages iterative tool calling, model turns, reasoning streaming, token budgeting, and stopping criteria.

use std::time::Instant;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum AgentState {
    Idle,
    Planning,
    Thinking,
    Streaming,
    ExecutingTool,
    Verifying,
    SelfReviewing,
    Done,
    Error,
}

#[derive(Debug, Clone)]
pub struct Message {
    pub role: String,
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub max_turns: usize,
    pub max_tool_retries: usize,
    pub auto_verify: bool,
    pub plan_mode: bool,
    pub temperature: f32,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            max_turns: 30,
            max_tool_retries: 3,
            auto_verify: true,
            plan_mode: false,
            temperature: 0.2,
        }
    }
}

pub struct AgentLoop {
    pub state: AgentState,
    pub config: AgentConfig,
    pub messages: Vec<Message>,
    pub turn_count: usize,
    pub tool_call_count: usize,
    pub start_time: Option<Instant>,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub last_error: Option<String>,
}

impl AgentLoop {
    pub fn new(config: AgentConfig) -> Self {
        Self {
            state: AgentState::Idle,
            config,
            messages: Vec::new(),
            turn_count: 0,
            tool_call_count: 0,
            start_time: None,
            total_input_tokens: 0,
            total_output_tokens: 0,
            last_error: None,
        }
    }

    pub fn start(&mut self, system_prompt: &str, user_goal: &str) {
        self.state = AgentState::Planning;
        self.start_time = Some(Instant::now());
        self.messages.clear();

        self.messages.push(Message {
            role: "system".to_string(),
            content: system_prompt.to_string(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        });

        self.messages.push(Message {
            role: "user".to_string(),
            content: user_goal.to_string(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        });
    }

    pub fn handle_model_response(&mut self, content: &str, tool_calls: Vec<ToolCall>) -> AgentState {
        self.turn_count += 1;

        if !tool_calls.is_empty() {
            self.state = AgentState::ExecutingTool;
            self.tool_call_count += tool_calls.len();
            self.messages.push(Message {
                role: "assistant".to_string(),
                content: content.to_string(),
                tool_calls,
                tool_call_id: None,
            });
        } else {
            self.messages.push(Message {
                role: "assistant".to_string(),
                content: content.to_string(),
                tool_calls: Vec::new(),
                tool_call_id: None,
            });

            if self.config.auto_verify {
                self.state = AgentState::Verifying;
            } else {
                self.state = AgentState::Done;
            }
        }

        if self.turn_count >= self.config.max_turns {
            self.state = AgentState::Done;
        }

        self.state
    }

    pub fn record_tool_result(&mut self, tool_call_id: &str, result: &str) {
        self.messages.push(Message {
            role: "tool".to_string(),
            content: result.to_string(),
            tool_calls: Vec::new(),
            tool_call_id: Some(tool_call_id.to_string()),
        });
        self.state = AgentState::Thinking;
    }

    pub fn elapsed_ms(&self) -> u128 {
        self.start_time
            .map(|t| t.elapsed().as_millis())
            .unwrap_or(0)
    }
}
