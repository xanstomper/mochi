import { describe, expect, it } from 'vitest';
import { generateProjectDocs } from './docgen.js';

describe('Documentation Generator (docgen)', () => {
  it('generates project docs with Mermaid diagrams and symbol tables', () => {
    const docs = generateProjectDocs(process.cwd(), { title: 'Mochi Agent Test Docs' });
    expect(docs.title).toBe('Mochi Agent Test Docs');
    expect(docs.moduleCount).toBeGreaterThan(0);
    expect(docs.symbolCount).toBeGreaterThan(0);
    expect(docs.mermaidDiagram).toContain('```mermaid');
    expect(docs.mermaidDiagram).toContain('graph TD;');
    expect(docs.markdown).toContain('## 🏗️ Architecture Diagram');
    expect(docs.markdown).toContain('## 📦 Modules & API Reference');
  });
});
