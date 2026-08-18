import { describe, it, expect } from 'vitest';
import { describeModelError, stripHtml } from './http-error.js';

describe('describeModelError', () => {
  it('parses a JSON error body and keeps its message', () => {
    const e = describeModelError(401, '{"error":{"message":"Invalid API key"}}', 'opencode/deepseek', 'test');
    expect(e.message).toContain('401');
    expect(e.message).toContain('Invalid API key');
    expect(e.message).toContain('Unauthorized');
  });

  it('strips HTML bodies (upstream HTML 404/401 pages)', () => {
    const html = '<!DOCTYPE html><html><head><title>Not Found</title></head><body>Oops <b>404</b>.</body></html>';
    const e = describeModelError(404, html, 'opencode/x', 'test');
    expect(e.message).not.toContain('<');
    expect(e.message).toContain('Not found');
    expect(e.message).not.toContain('<!DOCTYPE');
  });

  it('gives a model-id pointer in the message', () => {
    const e = describeModelError(400, 'bad', 'acme/model', 'Acme');
    expect(e.message).toContain('"acme/model"');
    expect(e.message).toContain('malformed');
  });

  it('handles a plain text detail with no matching hint', () => {
    const e = describeModelError(599, 'weird failure', 'm', 'p');
    expect(e.message).toContain('weird failure');
    expect(e.message).toContain('599');
  });
});

describe('stripHtml', () => {
  it('removes tags and collapses whitespace', () => {
    expect(stripHtml('<div>  <b>a</b>\n  b  </div>')).toBe('a b');
  });
});