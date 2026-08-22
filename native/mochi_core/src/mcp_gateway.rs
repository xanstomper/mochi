//! Model Context Protocol (MCP) JSON-RPC 2.0 Server and Gateway in Rust.

use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct McpTool {
    pub name: String,
    pub description: String,
    pub schema_json: String,
}

#[derive(Debug, Clone)]
pub struct McpServerConfig {
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

pub struct McpRegistry {
    pub tools: HashMap<String, McpTool>,
    pub servers: HashMap<String, McpServerConfig>,
}

impl Default for McpRegistry {
    fn default() -> Self {
        Self {
            tools: HashMap::new(),
            servers: HashMap::new(),
        }
    }
}

impl McpRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_server(&mut self, name: String, config: McpServerConfig) {
        self.servers.insert(name, config);
    }

    pub fn register_tool(&mut self, tool: McpTool) {
        self.tools.insert(tool.name.clone(), tool);
    }

    pub fn list_tools(&self) -> Vec<&McpTool> {
        self.tools.values().collect()
    }
}
