//! Terminal PTY runner, ANSI escape sequence stripper, and output ring buffer in Rust.

pub struct AnsiProcessor {
    pub strip_colors: bool,
}

impl Default for AnsiProcessor {
    fn default() -> Self {
        Self { strip_colors: false }
    }
}

impl AnsiProcessor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn strip_ansi_escape_codes(input: &str) -> String {
        let mut out = String::with_capacity(input.len());
        let mut in_escape = false;
        let mut chars = input.chars().peekable();

        while let Some(c) = chars.next() {
            if c == '\x1b' {
                in_escape = true;
                if chars.peek() == Some(&'[') {
                    chars.next();
                }
                continue;
            }

            if in_escape {
                if c.is_ascii_alphabetic() || c == 'm' || c == 'K' || c == 'H' || c == 'J' {
                    in_escape = false;
                }
                continue;
            }

            out.push(c);
        }

        out
    }
}

pub struct RingBuffer {
    pub capacity: usize,
    pub buffer: Vec<String>,
}

impl RingBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            buffer: Vec::with_capacity(capacity),
        }
    }

    pub fn push(&mut self, line: String) {
        if self.buffer.len() >= self.capacity {
            self.buffer.remove(0);
        }
        self.buffer.push(line);
    }

    pub fn content(&self) -> String {
        self.buffer.join("\n")
    }
}
