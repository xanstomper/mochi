// Model-name normalization, extracted from model/router.ts (P2 speed,
// startup budget): config.ts needs only this pure function, but importing it
// from router.js dragged the four provider SDK modules (openai, anthropic,
// gemini, antigravity — ~55ms ESM compile measured on the reference machine)
// into EVERY cli process, including light commands that never call a model.
// Keeping the normalizer in its own module lets config.js skip that graph;
// router.ts re-exports it so existing importers are unaffected.

/**
 * Robust model name normalizer:
 * 1. Strips provider prefixes ('freeinference/', 'opencode/', 'opencode-go/', etc.)
 *    on direct OpenAI-compatible providers (non-OpenRouter).
 * 2. Normalizes spacing/punctuation (e.g. 'deep seek v4 flash' -> 'deepseek-v4-flash').
 * 3. Fixes common typos (e.g. 'flah' -> 'flash').
 * 4. Gracefully aliases non-existent or misnamed models (e.g. 'glm-5.4-flash' -> 'glm-5.3-flash').
 */
export function normalizeModelName(rawModel: string, baseUrl?: string): string {
  if (!rawModel) return rawModel;
  let m = rawModel.trim();

  // If baseUrl is OpenRouter, OpenRouter requires 'vendor/model' format (e.g. anthropic/claude-3.5-sonnet).
  // For all direct providers (FreeInference, OpenCode, DeepSeek, OpenAI, Groq, Mistral, Zhipu, etc.),
  // endpoints accept bare model IDs without vendor prefixes.
  // Aggregators that REQUIRE vendor prefixes (Novita's deepseek/…, Nebius'
  // Qwen/…, Together's meta-llama/…) are exempt from stripping: stripping
  // deepseek/deepseek-v4.1-flash to deepseek-v4.1-flash 404s on Novita.
  const isOpenRouter = Boolean(baseUrl && baseUrl.includes('openrouter.ai'));
  const needsVendorPrefix = Boolean(baseUrl && /openrouter\.ai|novita\.ai|nebius|together\.xyz|fireworks\.ai|deepinfra\.com|models\.github\.ai|kilo\.ai/i.test(baseUrl));
  if (!isOpenRouter && !needsVendorPrefix) {
    m = m.replace(/^(?:freeinference|freeinforge|opencode-go|opencode|zen|go|openai|deepseek|zhipu|zai|anthropic|google|gemini|antigravity)\//i, '');
  }

  // Normalize whitespace, multiple dashes, and casing
  const clean = m.toLowerCase().replace(/[\s_]+/g, '-');

  // Typo correction: 'flah' -> 'flash'
  const deflashed = clean.replace(/flah$/i, 'flash').replace(/flah(?=-)/i, 'flash');

  // GLM models: FreeInference and OpenCode provide glm-5.3-flash and glm-5.3.
  // Users frequently ask for 'glm 5.4 flash' / 'glm-5.4-flash' / 'glm 5.4' / 'glm-5.4'.
  // Map these gracefully to the real available flash tier: glm-5.3-flash.
  if (
    deflashed === 'glm-5.4-flash' ||
    deflashed === 'glm-5.4' ||
    deflashed === 'glm5.4-flash' ||
    deflashed === 'glm5.4' ||
    deflashed === 'glm-flash' ||
    deflashed === 'glm-5-flash'
  ) {
    return 'glm-5.3-flash';
  }
  if (deflashed === 'glm-5.3-flash' || deflashed === 'glm-5.3' || deflashed === 'glm-5') {
    return deflashed;
  }

  // DeepSeek models: deep seek v4 flash -> deepseek-v4-flash
  // Note: On OpenCode, deepseek-v4-flash-free is a distinct model ID; on FreeInference it must be deepseek-v4-flash.
  if (deflashed === 'deepseek-v4-flash-free' || deflashed === 'deep-seek-v4-flash-free') {
    if (baseUrl && baseUrl.includes('freeinference')) {
      return 'deepseek-v4-flash';
    }
    return 'deepseek-v4-flash-free';
  }
  if (
    deflashed === 'deepseek-v4-flash' ||
    deflashed === 'deep-seek-v4-flash' ||
    deflashed === 'deepseek-flash' ||
    deflashed === 'deep-seek-flash' ||
    deflashed === 'deepseek-v4' ||
    deflashed === 'deep-seek-v4'
  ) {
    return 'deepseek-v4-flash';
  }

  // GPT models
  if (deflashed === 'gpt-5.4-nano' || deflashed === 'gpt5.4-nano' || deflashed === 'gpt-5.4nano') {
    return 'gpt-5.4-nano';
  }
  if (deflashed === 'gpt-5.4' || deflashed === 'gpt5.4') {
    return 'gpt-5.4';
  }

  // Qwen models
  if (deflashed === 'qwen3.6-35b' || deflashed === 'qwen-3.6-35b' || deflashed === 'qwen-3.6' || deflashed === 'qwen3.6') {
    return 'qwen3.6-35b';
  }

  // MiniMax
  if (deflashed === 'minimax-m3' || deflashed === 'minimaxm3') {
    return 'MiniMax-M3';
  }

  return m;
}
