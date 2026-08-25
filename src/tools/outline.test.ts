import { describe, expect, it } from 'vitest';
import { extractCodeOutline, outlineTool } from './outline.js';

describe('Outline Tool', () => {
  it('extracts TypeScript interfaces, classes, and functions', () => {
    const tsCode = `
import { foo } from './bar';

export interface User {
  id: string;
  name: string;
}

export type Status = 'active' | 'inactive';

export class UserManager {
  private users: User[] = [];

  public addUser(user: User): void {
    this.users.push(user);
  }

  async findUser(id: string): Promise<User | undefined> {
    return this.users.find(u => u.id === id);
  }
}

export function helper(): boolean {
  return true;
}
    `;

    const symbols = extractCodeOutline(tsCode, '.ts');
    expect(symbols.length).toBeGreaterThanOrEqual(5);

    const kinds = symbols.map(s => s.kind);
    expect(kinds).toContain('interface');
    expect(kinds).toContain('type');
    expect(kinds).toContain('class');
    expect(kinds).toContain('method');
    expect(kinds).toContain('function');
  });

  it('extracts Python classes and methods', () => {
    const pyCode = `
class DataProcessor:
    def __init__(self, name: str):
        self.name = name

    async def process(self, data: list) -> dict:
        return {"processed": True}

def standalone_task():
    pass
    `;

    const symbols = extractCodeOutline(pyCode, '.py');
    expect(symbols.length).toBe(4);
    expect(symbols[0].kind).toBe('class');
    expect(symbols[1].kind).toBe('method');
    expect(symbols[2].kind).toBe('method');
    expect(symbols[3].kind).toBe('function');
  });

  it('extracts Rust structs, enums, impls, and functions', () => {
    const rsCode = `
pub struct Config {
    pub timeout: u64,
}

pub enum Mode {
    Fast,
    Accurate,
}

impl Config {
    pub fn new() -> Self {
        Self { timeout: 30 }
    }
}

pub fn run() {
    println!("running");
}
    `;

    const symbols = extractCodeOutline(rsCode, '.rs');
    expect(symbols.length).toBeGreaterThanOrEqual(4);
    const kinds = symbols.map(s => s.kind);
    expect(kinds).toContain('struct');
    expect(kinds).toContain('enum');
    expect(kinds).toContain('impl');
    expect(kinds).toContain('function');
  });
});
