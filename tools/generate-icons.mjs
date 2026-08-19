/**
 * Generate the PWA icon set — no dependencies.
 *
 * iOS needs real PNGs: an SVG in the manifest is fine for Android but Safari
 * ignores it for the home-screen icon, and this app is meant to live on Nick's
 * phone. Rather than add an image toolchain to a project that has none, this
 * encodes PNGs directly — Node ships zlib, and PNG is a short spec.
 *
 * The mark is a chevron on the brand background: a vantage point is somewhere
 * high you see from. Deliberately geometric, because drawing letterforms without
 * a font library is where this would stop being worth it.
 *
 *   node tools/generate-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'public', 'icons');

const BG = [0x0e, 0x11, 0x16];      // --bg
const FG = [0x4c, 0x8d, 0xff];      // --accent

// ── PNG encoding ─────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** `pixels` is RGB, row-major. Filter byte 0 per scanline — no prediction. */
function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // colour type: truecolour
  // 10..12 = compression, filter, interlace — all 0

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── The mark ─────────────────────────────────────────────────────────────────

/**
 * An upward chevron, centred.
 *
 * `inset` is the share of the canvas left as margin. Maskable icons get a larger
 * one because Android crops to a circle and anything in the outer 10% can be
 * cut — a mark that survives that is worth more than one that fills the square.
 */
function draw(size, inset) {
  const px = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    px[i * 3] = BG[0]; px[i * 3 + 1] = BG[1]; px[i * 3 + 2] = BG[2];
  }

  const m = size * inset;
  const w = size - m * 2;
  const thickness = w * 0.22;
  const apexY = m + w * 0.30;
  const baseY = m + w * 0.78;
  const halfW = w / 2;
  const cx = size / 2;

  // Distance from the chevron's two arms; inside if within half the thickness.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.abs(x - cx);
      if (dx > halfW) continue;
      // The arm descends from the apex at a constant gradient.
      const armY = apexY + (dx / halfW) * (baseY - apexY);
      const dist = Math.abs(y - armY) * (halfW / Math.hypot(halfW, baseY - apexY));
      if (dist <= thickness / 2 && y >= apexY - thickness && y <= baseY + thickness) {
        const i = (y * size + x) * 3;
        px[i] = FG[0]; px[i + 1] = FG[1]; px[i + 2] = FG[2];
      }
    }
  }
  return px;
}

mkdirSync(OUT, { recursive: true });

const targets = [
  { name: 'icon-192.png', size: 192, inset: 0.18 },
  { name: 'icon-512.png', size: 512, inset: 0.18 },
  // Maskable: Android crops to a circle, so the mark sits further in.
  { name: 'icon-maskable-512.png', size: 512, inset: 0.28 },
  // iOS home screen. Safari applies its own rounding and ignores transparency.
  { name: 'apple-touch-icon.png', size: 180, inset: 0.16 },
  { name: 'favicon-32.png', size: 32, inset: 0.12 },
];

for (const t of targets) {
  writeFileSync(join(OUT, t.name), encodePng(t.size, t.size, draw(t.size, t.inset)));
  console.log(`wrote ${t.name} (${t.size}px)`);
}
