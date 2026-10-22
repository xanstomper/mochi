// Minimal PNG codec for the computer-use bridge: just enough to encode the
// RGBA framebuffers the display backends produce (8-bit RGBA, filter-0 rows,
// zlib deflate via node:zlib) and to decode those same files back for tests
// and tooling. No external dependencies — the repo ships zero-dep by design.
//
// The decoder intentionally supports only what the encoder emits (plus the
// standard per-row filters, which are cheap to undo). It is NOT a general
// PNG reader: palette/interlaced/16-bit inputs throw instead of guessing.

import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// CRC32 (PNG chunk checksums)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

/** Encode an RGBA framebuffer (width*height*4 bytes) as a PNG file. */
export function encodePngRgba(width: number, height: number, rgba: Buffer): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePngRgba: expected ${width * height * 4} bytes for ${width}x${height}, got ${rgba.length}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // [10] compression=0, [11] filter=0, [12] interlace=0

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Decoder (our own encoder's output shape: 8-bit RGB/RGBA, non-interlaced)
// ---------------------------------------------------------------------------

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA pixels, width*height*4 bytes. */
  rgba: Buffer;
}

export function decodePngRgba(png: Buffer): DecodedPng {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('decodePngRgba: not a PNG file');
  }
  let width = 0;
  let height = 0;
  let colorType = -1;
  let bitDepth = -1;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const len = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('decodePngRgba: interlaced PNGs unsupported');
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + len;
  }
  if (!width || (colorType !== 6 && colorType !== 2) || bitDepth !== 8) {
    throw new Error(`decodePngRgba: unsupported PNG (colorType=${colorType}, bitDepth=${bitDepth})`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 4);
  let prevRow: Buffer | null = null;
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const row = Buffer.from(raw.subarray(rowStart + 1, rowStart + 1 + stride));
    // Undo the row filter in place (Paeth included for completeness).
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prevRow ? prevRow[i] : 0;
      const c = prevRow && i >= bpp ? prevRow[i - bpp] : 0;
      switch (filter) {
        case 0: break;
        case 1: row[i] = (row[i] + a) & 0xff; break;
        case 2: row[i] = (row[i] + b) & 0xff; break;
        case 3: row[i] = (row[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: throw new Error(`decodePngRgba: unknown row filter ${filter}`);
      }
    }
    if (bpp === 4) {
      row.copy(out, y * width * 4);
    } else {
      for (let x = 0; x < width; x++) {
        out[(y * width + x) * 4] = row[x * 3];
        out[(y * width + x) * 4 + 1] = row[x * 3 + 1];
        out[(y * width + x) * 4 + 2] = row[x * 3 + 2];
        out[(y * width + x) * 4 + 3] = 255;
      }
    }
    prevRow = row;
  }
  return { width, height, rgba: out };
}
