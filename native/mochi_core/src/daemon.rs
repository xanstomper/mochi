//! Background Daemon & IPC Server in Rust.
//! Manages long-running agent tasks, background watchers, and status broadcasts.

use std::collections::HashMap;
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct DaemonTask {
    pub id: String,
    pub prompt: String,
    pub status: String,
    pub start_time: Instant,
    pub result: Option<String>,
}

pub struct DaemonServer {
    pub port: u16,
    pub running: bool,
    pub tasks: HashMap<String, DaemonTask>,
}

impl Default for DaemonServer {
    fn default() -> Self {
        Self {
            port: 9119,
            running: false,
            tasks: HashMap::new(),
        }
    }
}

impl DaemonServer {
    pub fn new(port: u16) -> Self {
        Self {
            port,
            running: false,
            tasks: HashMap::new(),
        }
    }

    pub fn register_task(&mut self, id: String, prompt: String) {
        self.tasks.insert(
            id.clone(),
            DaemonTask {
                id,
                prompt,
                status: "running".to_string(),
                start_time: Instant::now(),
                result: None,
            },
        );
    }

    pub fn complete_task(&mut self, id: &str, result: String) -> bool {
        if let Some(task) = self.tasks.get_mut(id) {
            task.status = "completed".to_string();
            task.result = Some(result);
            true
        } else {
            false
        }
    }

    pub fn task_status(&self, id: &str) -> Option<&DaemonTask> {
        self.tasks.get(id)
    }
}
