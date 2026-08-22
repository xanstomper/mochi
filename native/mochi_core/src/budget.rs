//! Multi-model token pricing, USD cost estimation, and budget tracker in Rust.

use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct ModelPricing {
    pub prompt_per_million: f64,
    pub completion_per_million: f64,
    pub cache_read_per_million: f64,
}

pub struct BudgetTracker {
    pub default_pricing: ModelPricing,
    pub custom_pricing: HashMap<String, ModelPricing>,
    pub total_prompt_tokens: u64,
    pub total_completion_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_cost_usd: f64,
}

impl Default for BudgetTracker {
    fn default() -> Self {
        let mut custom = HashMap::new();
        // DeepSeek V4 Flash
        custom.insert(
            "deepseek-v4-flash".to_string(),
            ModelPricing {
                prompt_per_million: 0.14,
                completion_per_million: 0.28,
                cache_read_per_million: 0.014,
            },
        );
        // Claude 3.5 Sonnet
        custom.insert(
            "claude-3-5-sonnet".to_string(),
            ModelPricing {
                prompt_per_million: 3.0,
                completion_per_million: 15.0,
                cache_read_per_million: 0.30,
            },
        );
        // GPT-4o
        custom.insert(
            "gpt-4o".to_string(),
            ModelPricing {
                prompt_per_million: 2.50,
                completion_per_million: 10.0,
                cache_read_per_million: 1.25,
            },
        );

        Self {
            default_pricing: ModelPricing {
                prompt_per_million: 0.50,
                completion_per_million: 1.50,
                cache_read_per_million: 0.10,
            },
            custom_pricing: custom,
            total_prompt_tokens: 0,
            total_completion_tokens: 0,
            total_cache_read_tokens: 0,
            total_cost_usd: 0.0,
        }
    }
}

impl BudgetTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get_pricing(&self, model: &str) -> &ModelPricing {
        let m_lower = model.to_ascii_lowercase();
        for (k, v) in &self.custom_pricing {
            if m_lower.contains(k) {
                return v;
            }
        }
        &self.default_pricing
    }

    pub fn estimate_cost(
        &self,
        model: &str,
        prompt_tokens: u64,
        completion_tokens: u64,
        cache_read_tokens: u64,
    ) -> f64 {
        let pricing = self.get_pricing(model);
        let prompt_cost = (prompt_tokens as f64 / 1_000_000.0) * pricing.prompt_per_million;
        let completion_cost = (completion_tokens as f64 / 1_000_000.0) * pricing.completion_per_million;
        let cache_cost = (cache_read_tokens as f64 / 1_000_000.0) * pricing.cache_read_per_million;
        prompt_cost + completion_cost + cache_cost
    }

    pub fn record_usage(
        &mut self,
        model: &str,
        prompt_tokens: u64,
        completion_tokens: u64,
        cache_read_tokens: u64,
    ) -> f64 {
        let cost = self.estimate_cost(model, prompt_tokens, completion_tokens, cache_read_tokens);
        self.total_prompt_tokens += prompt_tokens;
        self.total_completion_tokens += completion_tokens;
        self.total_cache_read_tokens += cache_read_tokens;
        self.total_cost_usd += cost;
        cost
    }
}
