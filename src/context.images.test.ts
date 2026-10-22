// Audit L-04: the token estimator must price image parts as images, not
// as their serialized payload. Before the fix a message carrying a data-URI
// image was charged ceil(bytes/4) over the base64 text (~1.4M tokens for a
// 4 MB image whose real vision cost is ~1–2K), while an https image URL was
// charged ~10 tokens — wrong in both directions, and enough to make
// compaction and the budget backstop fire wildly early in any session with
// screenshots or attached images.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextEngine,
  approxTokens,
  cachedMessageTokens,
  imagePartCount,
  messageHasImageParts,
  IMAGE_PART_TOKENS,
} from './context.js';
import type { MochiConfig, ChatMessage } from './types.js';

function cfg(): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake-model' },
    safety: { contextBudgetTokens: 100_000, maxIterations: 50, maxRuntimeMinutes: 10, mode: 'safe' as const },
  } as MochiConfig;
}

// ~1.4 MB of base64 — a ~1 MB image. Under the old counter this message
// alone estimated at ~350K tokens.
const BIG_DATA_URI = `data:image/png;base64,${'A'.repeat(1_400_000)}`;

const dataUriMessage = (): ChatMessage => ({
  role: 'user',
  content: [
    { type: 'text', text: 'What is in this screenshot?' },
    { type: 'image_url', image_url: { url: BIG_DATA_URI } },
  ],
} as ChatMessage);

describe('image-part token model (audit L-04)', () => {
  it('prices a data-URI image per image, never by its base64 payload', () => {
    const n = cachedMessageTokens(dataUriMessage());
    expect(n).toBeGreaterThanOrEqual(IMAGE_PART_TOKENS);
    // Text + JSON structure add a little; the payload must add nothing.
    expect(n).toBeLessThan(IMAGE_PART_TOKENS + 100);
  });

  it('prices an https image URL the same as a data URI (both are one image)', () => {
    const msg = {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://example.com/pic.png' } }],
    } as ChatMessage;
    const n = cachedMessageTokens(msg);
    expect(n).toBeGreaterThanOrEqual(IMAGE_PART_TOKENS);
    expect(n).toBeLessThan(IMAGE_PART_TOKENS + 100);
  });

  it('charges per image when a message carries several', () => {
    const msg = {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: BIG_DATA_URI } },
        { type: 'image_url', image_url: { url: BIG_DATA_URI } },
      ],
    } as ChatMessage;
    const n = cachedMessageTokens(msg);
    expect(n).toBeGreaterThanOrEqual(2 * IMAGE_PART_TOKENS);
    expect(n).toBeLessThan(2 * IMAGE_PART_TOKENS + 100);
  });

  it('leaves text-only counting exactly as before', () => {
    const textMsg = { role: 'assistant', content: 'Found it in src/parser.ts — error TS2345.' } as ChatMessage;
    expect(cachedMessageTokens(textMsg)).toBe(approxTokens(JSON.stringify(textMsg)));
    const partsMsg = {
      role: 'user',
      content: [{ type: 'text', text: 'just text parts, no images' }],
    } as ChatMessage;
    expect(cachedMessageTokens(partsMsg)).toBe(approxTokens(JSON.stringify(partsMsg)));
  });

  it('still counts the text parts around an image as text', () => {
    const longText = 'diagnostic line worth counting carefully '.repeat(50);
    const msg = {
      role: 'user',
      content: [
        { type: 'text', text: longText },
        { type: 'image_url', image_url: { url: BIG_DATA_URI } },
      ],
    } as ChatMessage;
    const n = cachedMessageTokens(msg);
    expect(n).toBeGreaterThan(IMAGE_PART_TOKENS + approxTokens(longText) - 50);
  });

  it('exposes the image-part detection the native-path gates use', () => {
    expect(imagePartCount(dataUriMessage().content)).toBe(1);
    expect(messageHasImageParts(dataUriMessage())).toBe(true);
    expect(messageHasImageParts({ content: 'plain' })).toBe(false);
    expect(messageHasImageParts({ content: [{ type: 'text', text: 'x' }] })).toBe(false);
    expect(messageHasImageParts({})).toBe(false);
  });

  it('keeps the async (native-batch) estimate in agreement on image histories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-img-tokens-'));
    const c = new ContextEngine(cfg(), dir, join(dir, 'no-skills'));
    // >24 messages so estimateTokensAsync would normally take the native
    // batch path; the image gate must route it to the TS walk instead.
    for (let i = 0; i < 25; i++) c.addMessage({ role: 'user', content: `turn ${i}` } as ChatMessage);
    c.addMessage(dataUriMessage());
    const sync = c.estimateTokens();
    expect(sync).toBeLessThan(25 * 20 + IMAGE_PART_TOKENS + 200);
    await expect(c.estimateTokensAsync()).resolves.toBe(sync);
  });
});
