// build-icons.cjs — generate Counter app icons for all platforms.
//
// Renders a gold "C" monogram on near-black (matching the in-app brand
// palette) and emits:
//   build/icon.png           1024x1024 — primary artifact for electron-builder
//   build/icon.iconset/      multi-resolution PNG set
//   build/icon.icns          macOS bundle icon (via iconutil)
//   build/icon.ico           Windows installer icon (multi-size PNG ICO)
//   build/icons/{N}x{N}.png  Linux icon set
//
// No npm dependencies: pure Node + zlib. Uses iconutil from macOS for icns.
// On non-mac dev machines the icns step is skipped (electron-builder
// regenerates it from the PNG at build time anyway).

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const ICONSET = path.join(BUILD, 'icon.iconset');
const LINUX = path.join(BUILD, 'icons');

const BG = [10, 12, 16, 255];        // #0A0C10 — bg-deep
const FG = [201, 168, 76, 255];      // #C9A84C — accent gold
const OPENING_DEG = 70;              // C opening on the right side
const OPENING_HALF = (OPENING_DEG / 2) * Math.PI / 180;

// Stroke geometry, expressed as fractions of canvas size so it scales
// cleanly to any resolution.
const STROKE_CENTER = 0.273;         // arc midline radius / size
const STROKE_HALF = 0.0635;          // half stroke width / size

// ----- Pixel rendering --------------------------------------------------

function renderRgba(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const rMid = STROKE_CENTER * size;
  const rHalf = STROKE_HALF * size;
  const rInner = rMid - rHalf;
  const rOuter = rMid + rHalf;
  // 4x4 supersampling for anti-aliasing.
  const N = 4;
  const step = 1 / N;
  const offset = step / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const px = x + offset + sx * step;
          const py = y + offset + sy * step;
          const dx = px - cx;
          const dy = py - cy;
          const d = Math.hypot(dx, dy);
          if (d < rInner || d > rOuter) continue;
          const theta = Math.atan2(dy, dx);
          if (Math.abs(theta) < OPENING_HALF) continue;
          cover++;
        }
      }
      const a = cover / (N * N);
      const idx = (y * size + x) * 4;
      buf[idx]     = Math.round(FG[0] * a + BG[0] * (1 - a));
      buf[idx + 1] = Math.round(FG[1] * a + BG[1] * (1 - a));
      buf[idx + 2] = Math.round(FG[2] * a + BG[2] * (1 - a));
      buf[idx + 3] = 255;
    }
  }
  return buf;
}

// ----- PNG encoding -----------------------------------------------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = zlib.crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(rgba, width, height) {
  // Each scanline is prefixed with a filter byte (0 = no filter).
  const scanlineLen = 1 + width * 4;
  const filtered = Buffer.alloc(height * scanlineLen);
  for (let y = 0; y < height; y++) {
    filtered[y * scanlineLen] = 0;
    rgba.copy(filtered, y * scanlineLen + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(filtered, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type: RGBA
  ihdr[10] = 0;   // compression: deflate
  ihdr[11] = 0;   // filter method: standard
  ihdr[12] = 0;   // interlace: none

  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function writePng(size, outPath) {
  const rgba = renderRgba(size);
  const png = encodePng(rgba, size, size);
  fs.writeFileSync(outPath, png);
  return png;
}

// ----- ICO encoding -----------------------------------------------------
//
// Windows .ico can wrap PNGs directly (supported since Vista). The format:
//   ICONDIR  (6 bytes)              reserved=0, type=1, count
//   ICONDIRENTRY[count] (16 bytes)  width, height, ..., bytesInRes, offset
//   image data (PNG payloads)

function encodeIco(pngsBySize) {
  const sizes = Object.keys(pngsBySize).map(Number).sort((a, b) => a - b);
  const count = sizes.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type = ICO
  header.writeUInt16LE(count, 4);          // image count

  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const payloads = [];
  sizes.forEach((size, i) => {
    const png = pngsBySize[size];
    // Per spec, 256 is encoded as 0 in the size byte.
    entries[i * 16 + 0] = size === 256 ? 0 : size;     // width
    entries[i * 16 + 1] = size === 256 ? 0 : size;     // height
    entries[i * 16 + 2] = 0;                            // palette count
    entries[i * 16 + 3] = 0;                            // reserved
    entries.writeUInt16LE(1, i * 16 + 4);               // color planes
    entries.writeUInt16LE(32, i * 16 + 6);              // bits per pixel
    entries.writeUInt32LE(png.length, i * 16 + 8);      // bytes in resource
    entries.writeUInt32LE(offset, i * 16 + 12);         // offset
    payloads.push(png);
    offset += png.length;
  });

  return Buffer.concat([header, entries, ...payloads]);
}

// ----- Orchestration ----------------------------------------------------

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

console.log('build-icons: rendering icon set…');

ensureDir(BUILD);
rmrf(ICONSET);
rmrf(LINUX);
ensureDir(ICONSET);
ensureDir(LINUX);

// Primary 1024x1024 PNG — used by electron-builder for cross-platform
// fallback and by the BrowserWindow.icon path on Linux.
const PRIMARY = path.join(BUILD, 'icon.png');
const png1024 = writePng(1024, PRIMARY);
console.log(`  ${PRIMARY}  (1024x1024, ${png1024.length} bytes)`);

// macOS iconset — iconutil bakes these into a .icns. The @2x suffix means
// "this PNG is double the nominal size", so icon_16x16@2x.png is 32x32.
const iconsetSpec = [
  ['icon_16x16.png',       16],
  ['icon_16x16@2x.png',    32],
  ['icon_32x32.png',       32],
  ['icon_32x32@2x.png',    64],
  ['icon_128x128.png',    128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png',    256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png',    512],
  ['icon_512x512@2x.png', 1024],
];
for (const [name, size] of iconsetSpec) {
  writePng(size, path.join(ICONSET, name));
}
console.log(`  ${ICONSET}/   (${iconsetSpec.length} resolutions)`);

// Linux icon set — electron-builder picks these up automatically.
const linuxSizes = [16, 32, 48, 64, 128, 256, 512];
for (const size of linuxSizes) {
  writePng(size, path.join(LINUX, `${size}x${size}.png`));
}
console.log(`  ${LINUX}/   (${linuxSizes.length} sizes)`);

// Windows .ico — multi-size PNG-in-ICO. Sizes 16/32/48/64/128/256 cover
// the Explorer, taskbar, and high-DPI display use cases.
const icoSizes = [16, 32, 48, 64, 128, 256];
const icoPngs = {};
for (const size of icoSizes) {
  icoPngs[size] = encodePng(renderRgba(size), size, size);
}
const icoBuf = encodeIco(icoPngs);
const ICO_PATH = path.join(BUILD, 'icon.ico');
fs.writeFileSync(ICO_PATH, icoBuf);
console.log(`  ${ICO_PATH}  (${icoSizes.length} sizes, ${icoBuf.length} bytes)`);

// macOS .icns — only when iconutil is available (i.e. on macOS).
const ICNS_PATH = path.join(BUILD, 'icon.icns');
try {
  execFileSync('iconutil', ['--convert', 'icns', ICONSET, '--output', ICNS_PATH], {
    stdio: 'inherit',
  });
  console.log(`  ${ICNS_PATH}  (via iconutil)`);
} catch (err) {
  console.warn('  iconutil not available — skipping .icns. electron-builder will regenerate it on the mac runner.');
}

console.log('build-icons: done.');
