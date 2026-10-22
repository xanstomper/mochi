// Inline screenshot images for the computer tool (Wave H3).
//
// Phase E's computer tool ended every action with a screenshot, but the model
// only received the file PATH — it acted blind unless it spent an extra turn
// reading the file back. This module turns a captured frame into the repo's
// existing image content part representation (an `image_url` part whose URL is
// a `data:` URI — the same shape the `read` tool produces for image files and
// that every provider serializer already renders), with a hard cap so a large
// desktop can never become a token bomb:
//
//   - max dimension 1280px (the reference resolution for computer-use
//     models; legible UI text, ~1/2 the pixels of a 1920x1200 frame), and
//   - max 1.5MB of PNG bytes (~2MB base64) — tighter than the read tool's
//     4MB raw cap, because screenshots are inlined AUTOMATICALLY after every
//     computer action and stay in context for the rest of the run.
//
// Downscaling reuses the repo's own PNG codec (src/computer/png.ts): every
// screenshot the tool takes was encoded by encodePngRgba (both the X11 and
// fake backends feed captureAndReport raw RGBA), so decode -> box-downsample
// -> re-encode is always available — no external image library needed. A
// frame that still exceeds the byte cap after repeated halving (e.g. pure
// sensor noise) is NOT inlined: buildScreenshotImage returns null and the
// caller falls back to the path-only result with a note.

import { decodePngRgba, encodePngRgba } from './png.js';

export const SCREENSHOT_INLINE_MAX_DIM = 1280;
export const SCREENSHOT_INLINE_MAX_BYTES = 1_500_000;

export interface DownscaledFrame {
  width: number;
  height: number;
  rgba: Buffer;
}

/** Box-average downscale so the longest side is at most maxDim. Aspect ratio
 *  is preserved; the frame is never upscaled. Deterministic (integer box
 *  bounds, rounded means) so tests can assert exact pixels. */
export function downscaleRgbaToFit(width: number, height: number, rgba: Buffer, maxDim: number): DownscaledFrame {
  const longest = Math.max(width, height);
  if (longest <= maxDim || width < 1 || height < 1) return { width, height, rgba };
  const scale = maxDim / longest;
  const newWidth = Math.max(1, Math.round(width * scale));
  const newHeight = Math.max(1, Math.round(height * scale));
  const out = Buffer.alloc(newWidth * newHeight * 4);
  for (let dy = 0; dy < newHeight; dy++) {
    const y0 = Math.floor((dy * height) / newHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((dy + 1) * height) / newHeight));
    for (let dx = 0; dx < newWidth; dx++) {
      const x0 = Math.floor((dx * width) / newWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((dx + 1) * width) / newWidth));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        let src = (y * width + x0) * 4;
        for (let x = x0; x < x1; x++) {
          r += rgba[src]; g += rgba[src + 1]; b += rgba[src + 2]; a += rgba[src + 3];
          src += 4; n++;
        }
      }
      const dst = (dy * newWidth + dx) * 4;
      out[dst] = Math.round(r / n);
      out[dst + 1] = Math.round(g / n);
      out[dst + 2] = Math.round(b / n);
      out[dst + 3] = Math.round(a / n);
    }
  }
  return { width: newWidth, height: newHeight, rgba: out };
}

export interface BuiltScreenshotImage {
  /** `data:image/png;base64,...` — ready for an `image_url` content part. */
  dataUri: string;
  /** Dimensions of the inlined image (after any downscale). */
  width: number;
  height: number;
  /** Dimensions of the captured frame. */
  origWidth: number;
  origHeight: number;
  /** PNG byte size of the inlined image (before base64). */
  bytes: number;
  downscaled: boolean;
}

/** Build a capped inline image from a screenshot PNG produced by
 *  encodePngRgba. Returns null when the frame cannot be brought under the
 *  byte cap (the caller then keeps the path-only result and notes why).
 *  A frame that already fits both caps is passed through byte-identical —
 *  no gratuitous re-encode. */
export function buildScreenshotImage(
  png: Buffer,
  opts: { maxDim?: number; maxBytes?: number } = {},
): BuiltScreenshotImage | null {
  const maxDim = opts.maxDim ?? SCREENSHOT_INLINE_MAX_DIM;
  const maxBytes = opts.maxBytes ?? SCREENSHOT_INLINE_MAX_BYTES;
  let decoded: { width: number; height: number; rgba: Buffer };
  try {
    decoded = decodePngRgba(png);
  } catch {
    return null; // not a frame our codec produced — never inline blind
  }
  const origWidth = decoded.width;
  const origHeight = decoded.height;
  let { width, height, rgba } = decoded;
  let out = png;
  if (width > maxDim || height > maxDim) {
    const d = downscaleRgbaToFit(width, height, rgba, maxDim);
    width = d.width; height = d.height; rgba = d.rgba;
    out = encodePngRgba(width, height, rgba);
  }
  // Byte cap: halve the longest side until the PNG fits or the frame is too
  // small for another halving to be useful (a 64px floor keeps the loop
  // bounded; below that the image is useless anyway).
  while (out.length > maxBytes && width > 64 && height > 64) {
    const d = downscaleRgbaToFit(width, height, rgba, Math.floor(Math.max(width, height) / 2));
    if (d.width === width && d.height === height) break;
    width = d.width; height = d.height; rgba = d.rgba;
    out = encodePngRgba(width, height, rgba);
  }
  if (out.length > maxBytes) return null;
  return {
    dataUri: `data:image/png;base64,${out.toString('base64')}`,
    width,
    height,
    origWidth,
    origHeight,
    bytes: out.length,
    downscaled: width !== origWidth || height !== origHeight,
  };
}
