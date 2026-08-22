//! Skills Directory Indexer & Runner in Rust.

use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: String,
    pub instructions: String,
}

pub struct SkillRegistry {
    pub skills: HashMap<String, Skill>,
}

impl Default for SkillRegistry {
    fn default() -> Self {
        Self {
            skills: HashMap::new(),
        }
    }
}

impl SkillRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, skill: Skill) {
        self.skills.insert(skill.name.clone(), skill);
    }

    pub fn find(&self, query: &str) -> Vec<&Skill> {
        let q = query.to_ascii_lowercase();
        self.skills
            .values()
            .filter(|s| s.name.to_ascii_lowercase().contains(&q) || s.description.to_ascii_lowercase().contains(&q))
            .collect()
    }
}
