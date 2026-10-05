import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateCodebaseMap, formatCodebaseMap, codebaseMapTool } from './codebase-map.js';

describe('Codebase Map Tool', () => {
  it('maps current Mochi repository accurately', () => {
    const map = generateCodebaseMap(process.cwd());
    expect(map.totalFiles).toBeGreaterThan(50);
    expect(map.totalLines).toBeGreaterThan(10000);
    expect(map.manifests).toContain('package.json');
    expect(map.projectTypes).toContain('Node.js / JS Ecosystem');
    expect(map.languages['TypeScript']).toBeDefined();

    const formatted = formatCodebaseMap(map, 'standard');
    expect(formatted).toContain('🗺️ Codebase Map');
    expect(formatted).toContain('TypeScript');
    expect(formatted).toContain('Architecture & Modules');
  });

  it('correctly maps simulated multi-module repository structure', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mochi-map-test-'));
    try {
      // Create simulated project
      writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "test-crate"\nversion = "0.1.0"\n', 'utf8');
      
      const srcDir = join(tempDir, 'src');
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, 'main.rs'), 'pub fn start() {\n    println!("hello");\n}\n', 'utf8');

      const toolsDir = join(srcDir, 'tools');
      mkdirSync(toolsDir);
      writeFileSync(join(toolsDir, 'handler.rs'), 'pub struct Handler;\n', 'utf8');

      const map = generateCodebaseMap(tempDir);
      expect(map.manifests).toContain('Cargo.toml');
      expect(map.projectTypes).toContain('Rust / Cargo');
      expect(map.languages['Rust']).toBeDefined();
      expect(map.languages['Rust'].files).toBe(2);

      const formatted = formatCodebaseMap(map, 'compact');
      expect(formatted).toContain('Rust / Cargo');
      expect(formatted).toContain('main.rs');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('executes via codebaseMapTool', async () => {
    const res = await codebaseMapTool.execute({ detail_level: 'compact' }, { cwd: process.cwd() } as any);
    expect(typeof res).toBe('string');
    expect(res).toContain('Codebase Map');
  });
});
