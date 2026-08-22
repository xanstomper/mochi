//! Agent Control Protocol (ACP) & Tool Gateway in Rust.
//! Validates client RPC messages, routes tool requests, and packages streaming responses.

use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct AcpRequest {
    pub id: String,
    pub method: String,
    pub params: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct AcpResponse {
    pub id: String,
    pub success: bool,
    pub result: Option<String>,
    pub error: Option<String>,
}

pub struct AcpGateway {
    pub handlers: HashMap<String, Box<fn(&HashMap<String, String>) -> Result<String, String>>>,
}

impl Default for AcpGateway {
    fn default() -> Self {
        Self {
            handlers: HashMap::new(),
        }
    }
}

impl AcpGateway {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn handle(&self, req: AcpRequest) -> AcpResponse {
        if let Some(handler) = self.handlers.get(&req.method) {
            match handler(&req.params) {
                Ok(res) => AcpResponse {
                    id: req.id,
                    success: true,
                    result: Some(res),
                    error: None,
                },
                Err(err) => AcpResponse {
                    id: req.id,
                    success: false,
                    result: None,
                    error: Some(err),
                },
            }
        } else {
            AcpResponse {
                id: req.id,
                success: false,
                result: None,
                error: Some(format!("Unknown method: {}", req.method)),
            }
        }
    }
}
