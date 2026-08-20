// Interactive clarification (spec section 12-B): when requirements have
// architectural trade-offs, halt and present a multi-choice selection instead
// of silently assuming. The core is transport-agnostic: resolveChoice turns a
// raw answer ("", "1", "jwt") into a Choice, and askUserChoice drives any
// renderer (TUI, terminal, headless) with a default fallback.
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';

export interface Choice {
  id: string;
  label: string;
  recommended?: boolean;
  hint?: string;
}

export interface ClarifyQuestion {
  title: string;
  choices: Choice[];
  defaultValue?: string;
}

export interface Renderer {
  render(q: ClarifyQuestion): string;
  receive(): Promise<string>;
}

/** The spec's numbered-menu rendering (also usable for non-TTY preview). */
export function renderMenu(q: ClarifyQuestion): string {
  const lines = [`? ${q.title}`, ''];
  q.choices.forEach((c, i) => {
    const mark = c.recommended ? ' (recommended)' : '';
    lines.push(`   [${i + 1}] ${c.label}${mark}`);
    if (c.hint) lines.push(`         ${c.hint}`);
  });
  lines.push('');
  return lines.join('\n');
}

/** Resolve a raw user answer to a Choice. Numeric index, id, or label prefix;
 *  empty/unmatched falls back to the default (or first) choice — so headless
 *  automation always gets a deterministic answer. */
export function resolveChoice(q: ClarifyQuestion, raw: string | null): MenuOutcome {
  const trimmed = (raw ?? '').trim();
  const fallback = (): MenuOutcome => {
    const d = q.choices.find((c) => c.id === q.defaultValue) ?? q.choices[0] ?? null;
    return { choice: d, usedDefault: true };
  };
  if (!trimmed) return fallback();
  const n = Number(trimmed);
  if (Number.isInteger(n) && n >= 1 && n <= q.choices.length) {
    return { choice: q.choices[n - 1], usedDefault: false };
  }
  const byId = q.choices.find((c) => c.id.toLowerCase() === trimmed.toLowerCase());
  if (byId) return { choice: byId, usedDefault: false };
  const byLabel = q.choices.find((c) => c.label.toLowerCase().startsWith(trimmed.toLowerCase()));
  if (byLabel) return { choice: byLabel, usedDefault: false };
  return fallback();
}

export interface MenuOutcome {
  choice: Choice | null;
  usedDefault: boolean;
}

/** Ask via an injected render/receive pair. Defaults to a terminal readline
 *  when omitted so `mochi ask` is usable out of the box. */
export async function askUserChoice(
  q: ClarifyQuestion,
  renderer: Renderer = defaultRenderer(),
): Promise<MenuOutcome> {
  renderer.render(q);
  const raw = await renderer.receive();
  return resolveChoice(q, raw);
}

/** Terminal renderer: prints the numbered menu and reads one line. */
export function defaultRenderer(): Renderer {
  const rl = createInterface({ input: stdin, output: stdout });
  return {
    render(q) {
      process.stdout.write(renderMenu(q) + '   Choice: ');
      return q.title;
    },
    async receive() {
      const line = await new Promise<string>((res) => rl.question('', res));
      rl.close();
      return line;
    },
  };
}