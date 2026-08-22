//! ANSI Escape Formatter, TrueColor Palette Mapper, and Terminal Box Drawing in Rust.

pub struct TerminalRenderer {
    pub width: usize,
    pub height: usize,
    pub true_color: bool,
}

impl Default for TerminalRenderer {
    fn default() -> Self {
        Self {
            width: 80,
            height: 24,
            true_color: true,
        }
    }
}

impl TerminalRenderer {
    pub fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            true_color: true,
        }
    }

    pub fn draw_box(title: &str, content: &str, width: usize) -> String {
        let inner_width = width.saturating_sub(4).max(10);
        let top = format!("┌─ {} {}┐", title, "─".repeat(inner_width.saturating_sub(title.len() + 1)));
        let bottom = format!("└{}┘", "─".repeat(inner_width + 2));

        let mut lines = vec![top];
        for line in content.lines() {
            let truncated = if line.len() > inner_width {
                &line[..inner_width]
            } else {
                line
            };
            lines.push(format!("│ {}{} │", truncated, " ".repeat(inner_width.saturating_sub(truncated.len()))));
        }
        lines.push(bottom);
        lines.join("\n")
    }

    pub fn highlight_syntax(code: &str) -> String {
        let keywords = ["fn", "let", "mut", "pub", "struct", "enum", "impl", "use", "const", "return", "async", "await", "function", "import", "export"];
        let mut out = String::with_capacity(code.len() + 64);

        for word in code.split_whitespace() {
            if keywords.contains(&word) {
                out.push_str("\x1b[38;2;163;230;53m");
                out.push_str(word);
                out.push_str("\x1b[0m ");
            } else {
                out.push_str(word);
                out.push(' ');
            }
        }

        out
    }
}
