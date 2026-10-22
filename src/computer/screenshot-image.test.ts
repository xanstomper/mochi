// Wave H3: the inline-screenshot builder — cap behavior is TESTED here, not
// asserted: dimension cap, byte cap (downscale-until-it-fits), the
// reject-when-unfittable path, and byte-exact round-trips for frames that
// already fit.
import { describe, it, expect } from 'vitest';
import { FakeDisplayBackend } from './fake-display.js';
import { encodePngRgba, decodePngRgba } from './png.js';
import {
  buildScreenshotImage,
  downscaleRgbaToFit,
  SCREENSHOT_INLINE_MAX_DIM,
  SCREENSHOT_INLINE_MAX_BYTES,
} from './screenshot-image.js';

/** Deterministic incompressible frame (seeded LCG) — PNG cannot shrink it,
 *  so only downscaling can bring it under a byte cap. */
function noiseRgba(width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  let s = 0x12345678;
  for (let i = 0; i < buf.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    buf[i] = (s >>> 24) & 0xff;
  }
  return buf;
}

function dataUriPayload(dataUri: string): Buffer {
  const prefix = 'data:image/png;base64,';
  expect(dataUri.startsWith(prefix)).toBe(true);
  return Buffer.from(dataUri.slice(prefix.length), 'base64');
}

describe('buildScreenshotImage', () => {
  it('passes a small frame through byte-identical, decodable to the fake frame', async () => {
    const fake = new FakeDisplayBackend(800, 600);
    const rgba = await fake.captureRgba();
    const png = encodePngRgba(800, 600, rgba);
    const built = buildScreenshotImage(png);
    expect(built).not.toBeNull();
    expect(built!.downscaled).toBe(false);
    expect(built!.width).toBe(800);
    expect(built!.height).toBe(600);
    expect(built!.bytes).toBe(png.length);
    const decoded = decodePngRgba(dataUriPayload(built!.dataUri));
    expect(decoded.width).toBe(800);
    expect(decoded.height).toBe(600);
    expect(decoded.rgba.equals(rgba)).toBe(true);
  });

  it('downscales an oversized capture to the max dimension, preserving aspect', async () => {
    const fake = new FakeDisplayBackend(2560, 1440);
    const rgba = await fake.captureRgba();
    const png = encodePngRgba(2560, 1440, rgba);
    const built = buildScreenshotImage(png);
    expect(built).not.toBeNull();
    expect(built!.downscaled).toBe(true);
    expect(built!.origWidth).toBe(2560);
    expect(built!.origHeight).toBe(1440);
    expect(built!.width).toBe(SCREENSHOT_INLINE_MAX_DIM);
    expect(built!.height).toBe(720);
    expect(built!.bytes).toBeLessThanOrEqual(SCREENSHOT_INLINE_MAX_BYTES);
    const decoded = decodePngRgba(dataUriPayload(built!.dataUri));
    expect(decoded.width).toBe(SCREENSHOT_INLINE_MAX_DIM);
    expect(decoded.height).toBe(720);
  });

  it('brings an incompressible frame under the byte cap by downscaling', () => {
    const png = encodePngRgba(800, 600, noiseRgba(800, 600));
    expect(png.length).toBeGreaterThan(SCREENSHOT_INLINE_MAX_BYTES);
    const built = buildScreenshotImage(png);
    expect(built).not.toBeNull();
    expect(built!.bytes).toBeLessThanOrEqual(SCREENSHOT_INLINE_MAX_BYTES);
    expect(built!.downscaled).toBe(true);
    expect(built!.width).toBeLessThan(800);
    // The inlined bytes are a real PNG of the stated dimensions.
    const decoded = decodePngRgba(dataUriPayload(built!.dataUri));
    expect(decoded.width).toBe(built!.width);
    expect(decoded.height).toBe(built!.height);
  });

  it('returns null when the frame cannot fit the byte cap (reject-with-note path)', () => {
    const png = encodePngRgba(800, 600, noiseRgba(800, 600));
    expect(buildScreenshotImage(png, { maxBytes: 2048 })).toBeNull();
  });

  it('returns null for bytes that are not one of our PNG frames', () => {
    expect(buildScreenshotImage(Buffer.from('definitely not a png'))).toBeNull();
  });
});

describe('downscaleRgbaToFit', () => {
  it('box-averages exact 2x2 quadrants', () => {
    // 4x4 frame: TL red, TR green, BL blue, BR white (uniform 2x2 blocks).
    const px = (r: number, g: number, b: number) => [r, g, b, 255];
    const rows: number[][] = [];
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        if (y < 2 && x < 2) rows.push(px(255, 0, 0));
        else if (y < 2) rows.push(px(0, 255, 0));
        else if (x < 2) rows.push(px(0, 0, 255));
        else rows.push(px(255, 255, 255));
      }
    }
    const rgba = Buffer.from(rows.flat());
    const out = downscaleRgbaToFit(4, 4, rgba, 2);
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect([...out.rgba]).toEqual([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      255, 255, 255, 255,
    ]);
  });

  it('never upscales a frame that already fits', () => {
    const rgba = Buffer.alloc(4 * 4 * 4, 7);
    const out = downscaleRgbaToFit(4, 4, rgba, 1280);
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
    expect(out.rgba).toBe(rgba);
  });
});
