// PNG codec round-trip tests (computer bridge, Phase E12).
import { describe, it, expect } from 'vitest';
import { encodePngRgba, decodePngRgba } from './png.js';

function pattern(width: number, height: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = (x * 7 + y * 3) & 0xff;
      rgba[i + 1] = (x + y * 11) & 0xff;
      rgba[i + 2] = (x * x + y) & 0xff;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

describe('png codec', () => {
  it('round-trips an RGBA framebuffer pixel-exactly', () => {
    const rgba = pattern(37, 23); // odd size on purpose (row padding traps)
    const png = encodePngRgba(37, 23, rgba);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const decoded = decodePngRgba(png);
    expect(decoded.width).toBe(37);
    expect(decoded.height).toBe(23);
    expect(decoded.rgba.equals(rgba)).toBe(true);
  });

  it('round-trips a 1x1 image', () => {
    const rgba = Buffer.from([10, 20, 30, 255]);
    const decoded = decodePngRgba(encodePngRgba(1, 1, rgba));
    expect([...decoded.rgba]).toEqual([10, 20, 30, 255]);
  });

  it('rejects non-PNG input and size mismatches', () => {
    expect(() => decodePngRgba(Buffer.from('not a png at all'))).toThrow(/not a PNG/);
    expect(() => encodePngRgba(4, 4, Buffer.alloc(10))).toThrow(/expected 64 bytes/);
  });
});
