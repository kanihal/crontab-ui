#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;
const OUT = path.join(__dirname, '..', 'build', 'icon-1024.png');
const pixels = Buffer.alloc(SIZE * SIZE * 4);

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function setPixel(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const srcA = a / 255;
  const dstA = pixels[i + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA === 0) return;
  pixels[i] = Math.round((r * srcA + pixels[i] * dstA * (1 - srcA)) / outA);
  pixels[i + 1] = Math.round((g * srcA + pixels[i + 1] * dstA * (1 - srcA)) / outA);
  pixels[i + 2] = Math.round((b * srcA + pixels[i + 2] * dstA * (1 - srcA)) / outA);
  pixels[i + 3] = Math.round(outA * 255);
}

function inRoundRect(x, y, w, h, r) {
  const dx = Math.max(r - x, 0, x - (w - r));
  const dy = Math.max(r - y, 0, y - (h - r));
  return dx * dx + dy * dy <= r * r;
}

function fillRoundRect(x0, y0, w, h, r, colorAt) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      if (!inRoundRect(x - x0, y - y0, w, h, r)) continue;
      const [red, green, blue, alpha] = colorAt(x, y);
      setPixel(x, y, red, green, blue, alpha);
    }
  }
}

function fillCircle(cx, cy, radius, r, g, b, a = 255) {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y += 1) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPixel(x, y, r, g, b, a);
    }
  }
}

function strokeCircle(cx, cy, radius, width, r, g, b, a = 255) {
  const half = width / 2;
  const min = (radius - half) * (radius - half);
  const max = (radius + half) * (radius + half);
  for (let y = Math.floor(cy - radius - half); y <= Math.ceil(cy + radius + half); y += 1) {
    for (let x = Math.floor(cx - radius - half); x <= Math.ceil(cx + radius + half); x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min && d2 <= max) setPixel(x, y, r, g, b, a);
    }
  }
}

function strokeLine(x1, y1, x2, y2, width, r, g, b, a = 255) {
  const minX = Math.floor(Math.min(x1, x2) - width);
  const maxX = Math.ceil(Math.max(x1, x2) + width);
  const minY = Math.floor(Math.min(y1, y2) - width);
  const maxY = Math.ceil(Math.max(y1, y2) + width);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const radius = width / 2;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2));
      const px = x1 + t * dx;
      const py = y1 + t * dy;
      const ddx = x - px;
      const ddy = y - py;
      if (ddx * ddx + ddy * ddy <= radius * radius) setPixel(x, y, r, g, b, a);
    }
  }
}

function drawIcon() {
  fillRoundRect(0, 0, SIZE, SIZE, Math.round(SIZE * 0.22), (x, y) => {
    const t = (x + y) / (SIZE * 2);
    return [lerp(91, 43, t), lerp(108, 47, t), lerp(255, 138, t), 255];
  });

  fillRoundRect(
    Math.round(SIZE * 0.04),
    Math.round(SIZE * 0.04),
    Math.round(SIZE * 0.92),
    Math.round(SIZE * 0.45),
    Math.round(SIZE * 0.18),
    () => [255, 255, 255, 16],
  );

  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const radius = SIZE * 0.34;
  fillCircle(cx, cy, radius, 255, 255, 255);
  strokeCircle(cx, cy, radius, SIZE * 0.018, 31, 36, 54);

  for (let i = 0; i < 12; i += 1) {
    const angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
    const long = i % 3 === 0;
    const r1 = radius * (long ? 0.78 : 0.86);
    const r2 = radius * 0.96;
    strokeLine(
      cx + Math.cos(angle) * r1,
      cy + Math.sin(angle) * r1,
      cx + Math.cos(angle) * r2,
      cy + Math.sin(angle) * r2,
      SIZE * (long ? 0.018 : 0.01),
      31,
      36,
      54,
    );
  }

  strokeLine(cx, cy, cx + Math.cos(-Math.PI / 2 - Math.PI / 3) * radius * 0.5, cy + Math.sin(-Math.PI / 2 - Math.PI / 3) * radius * 0.5, SIZE * 0.03, 31, 36, 54);
  strokeLine(cx, cy, cx + Math.cos(-Math.PI / 2 + Math.PI / 3) * radius * 0.72, cy + Math.sin(-Math.PI / 2 + Math.PI / 3) * radius * 0.72, SIZE * 0.022, 91, 108, 255);
  fillCircle(cx, cy, SIZE * 0.024, 31, 36, 54);

  const bx = SIZE * 0.7;
  const by = SIZE * 0.7;
  const br = SIZE * 0.16;
  fillCircle(bx, by, br, 31, 36, 54);
  strokeLine(bx - br * 0.3, by - br * 0.3, bx + br * 0.05, by, SIZE * 0.022, 123, 227, 139);
  strokeLine(bx + br * 0.05, by, bx - br * 0.3, by + br * 0.3, SIZE * 0.022, 123, 227, 139);
  strokeLine(bx + br * 0.18, by + br * 0.32, bx + br * 0.5, by + br * 0.32, SIZE * 0.022, 123, 227, 139);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function writePng() {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (SIZE * 4 + 1)] = 0;
    pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

drawIcon();
writePng();
console.log(`wrote ${OUT}`);
