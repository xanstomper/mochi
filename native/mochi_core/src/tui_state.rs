//! Terminal UI State Reducer and Event Model in Rust.

#[derive(Debug, Clone)]
pub struct TuiLine {
    pub kind: String,
    pub text: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone)]
pub struct TuiTask {
    pub id: String,
    pub tool: String,
    pub args: String,
    pub status: String,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Default)]
pub struct TuiState {
    pub lines: Vec<TuiLine>,
    pub tasks: Vec<TuiTask>,
    pub auto_improve: bool,
    pub total_cost_usd: f64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub last_tool: Option<String>,
}

impl TuiState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_line(&mut self, kind: &str, text: &str) {
        self.lines.push(TuiLine {
            kind: kind.to_string(),
            text: text.to_string(),
            timestamp: 0,
        });
        if self.lines.len() > 1000 {
            self.lines.remove(0);
        }
    }

    pub fn add_task(&mut self, id: String, tool: String, args: String) {
        self.tasks.push(TuiTask {
            id,
            tool: tool.clone(),
            args,
            status: "running".to_string(),
            duration_ms: None,
        });
        self.last_tool = Some(tool);
    }

    pub fn complete_task(&mut self, id: &str, duration_ms: u64) {
        if let Some(task) = self.tasks.iter_mut().find(|t| t.id == id) {
            task.status = "completed".to_string();
            task.duration_ms = Some(duration_ms);
        }
    }
}
