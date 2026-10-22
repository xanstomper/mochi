// Fake display backend tests (computer bridge, Phase E12): the fake must be
// deterministic (same actions → byte-identical frames) and reactive
// (different actions → visibly different frames), since tool tests rely on
// it as the stand-in for a real screen.
import { describe, it, expect } from 'vitest';
import { FakeDisplayBackend } from './fake-display.js';
import { encodePngRgba } from './png.js';

async function shotPng(b: FakeDisplayBackend): Promise<Buffer> {
  const info = await b.info();
  return encodePngRgba(info.width, info.height, await b.captureRgba());
}

describe('fake display backend', () => {
  it('is deterministic: identical action sequences give identical screenshots', async () => {
    const run = async () => {
      const b = new FakeDisplayBackend(320, 200);
      await b.movePointer(50, 60);
      await b.button(1, true);
      await b.button(1, false);
      await b.key('h', true);
      await b.key('h', false);
      await b.key('i', true);
      await b.key('i', false);
      return shotPng(b);
    };
    const a = await run();
    const b2 = await run();
    expect(a.equals(b2)).toBe(true);
  });

  it('pointer moves are reflected in pointer() and change the frame', async () => {
    const b = new FakeDisplayBackend(320, 200);
    const before = await shotPng(b);
    await b.movePointer(10, 10);
    expect(await b.pointer()).toMatchObject({ x: 10, y: 10 });
    const after = await shotPng(b);
    expect(after.equals(before)).toBe(false);
  });

  it('typing accumulates text and changes the frame', async () => {
    const b = new FakeDisplayBackend(320, 200);
    const before = await shotPng(b);
    await b.key('x', true);
    await b.key('x', false);
    expect(b.typedText).toBe('x');
    expect(b.keyLog).toEqual(['x:down', 'x:up']);
    const after = await shotPng(b);
    expect(after.equals(before)).toBe(false);
    await b.key('BackSpace', true);
    expect(b.typedText).toBe('');
  });

  it('tracks button state in the pointer mask and log', async () => {
    const b = new FakeDisplayBackend(320, 200);
    await b.button(1, true);
    expect((await b.pointer()).mask & 0x100).toBe(0x100);
    await b.button(1, false);
    expect((await b.pointer()).mask & 0x100).toBe(0);
    expect(b.buttonLog).toEqual(['b1:down', 'b1:up']);
  });

  it('rejects unknown keys instead of guessing', async () => {
    const b = new FakeDisplayBackend(320, 200);
    await expect(b.key('definitely-not-a-key', true)).rejects.toThrow(/unknown key/);
  });

  it('clamps pointer moves to the display bounds', async () => {
    const b = new FakeDisplayBackend(320, 200);
    await b.movePointer(9999, -5);
    expect(await b.pointer()).toMatchObject({ x: 319, y: 0 });
  });
});
