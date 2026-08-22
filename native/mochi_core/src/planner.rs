//! Task planner, objective classifier, and step breakdown engine in Rust.

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum TaskKind {
    CodeEdit,
    Investigation,
    Testing,
    Refactor,
    Architecture,
    OneShotAnswer,
}

pub struct TaskStep {
    pub id: usize,
    pub description: String,
    pub kind: TaskKind,
    pub files: Vec<String>,
    pub completed: bool,
}

pub struct PlanEngine {
    pub steps: Vec<TaskStep>,
    pub current_step: usize,
}

impl Default for PlanEngine {
    fn default() -> Self {
        Self {
            steps: Vec::new(),
            current_step: 0,
        }
    }
}

impl PlanEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn classify_prompt(prompt: &str) -> TaskKind {
        let p = prompt.to_ascii_lowercase();
        if p.contains("why ") || p.contains("what is") || p.contains("explain") || p.contains("how does") {
            TaskKind::Investigation
        } else if p.contains("test") || p.contains("verify") || p.contains("benchmark") {
            TaskKind::Testing
        } else if p.contains("refactor") || p.contains("clean up") || p.contains("restructure") {
            TaskKind::Refactor
        } else if p.contains("design") || p.contains("architecture") || p.contains("diagram") {
            TaskKind::Architecture
        } else if p.contains("fix") || p.contains("implement") || p.contains("add") || p.contains("update") {
            TaskKind::CodeEdit
        } else {
            TaskKind::OneShotAnswer
        }
    }

    pub fn add_step(&mut self, description: String, kind: TaskKind, files: Vec<String>) {
        let id = self.steps.len() + 1;
        self.steps.push(TaskStep {
            id,
            description,
            kind,
            files,
            completed: false,
        });
    }

    pub fn complete_current(&mut self) -> bool {
        if self.current_step < self.steps.len() {
            self.steps[self.current_step].completed = true;
            self.current_step += 1;
            true
        } else {
            false
        }
    }
}
