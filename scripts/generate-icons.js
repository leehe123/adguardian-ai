/**
 * 图标生成脚本 - 用 Node.js 内置 zlib 模块生成纯色盾牌 PNG
 * 运行: node scripts/generate-icons.js
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// CRC32 表
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      if (c & 1) c = 0xEDB88320 ^ (c >>> 1);
      else c = c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function createPNG(size) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8;   // bit depth
  ihdrData[9] = 6;   // color type RGBA
  ihdrData[10] = 0;  // compression
  ihdrData[11] = 0;  // filter
  ihdrData[12] = 0;  // interlace

  // 绘制盾牌图案
  const rowSize = 1 + size * 4;
  const rawData = Buffer.alloc(rowSize * size);

  // 颜色
  const bgR = 0, bgG = 0, bgB = 0, bgA = 0;           // 透明背景
  const shieldR = 29, shieldG = 158, shieldB = 117;    // #1D9E75
  const checkR = 255, checkG = 255, checkB = 255;      // 白色对勾

  for (let y = 0; y < size; y++) {
    rawData[y * rowSize] = 0; // filter: none

    for (let x = 0; x < size; x++) {
      const offset = y * rowSize + 1 + x * 4;
      let r = bgR, g = bgG, b = bgB, a = bgA;

      const nx = x / size; // 0-1
      const ny = y / size; // 0-1

      // 盾牌形状
      const inShield = isShield(nx, ny, size);

      if (inShield) {
        r = shieldR;
        g = shieldG;
        b = shieldB;
        a = 255;

        // 对勾
        if (isCheck(nx, ny, size)) {
          r = checkR;
          g = checkG;
          b = checkB;
        }
      }

      rawData[offset] = r;
      rawData[offset + 1] = g;
      rawData[offset + 2] = b;
      rawData[offset + 3] = a;
    }
  }

  const compressed = zlib.deflateSync(rawData);

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 盾牌形状判定 */
function isShield(nx, ny, size) {
  // 盾牌轮廓：上方矩形 + 下方三角弧
  // nx, ny 都是 0-1，左上角 (0,0)
  const cx = 0.5;

  // 上半部分（0.15 - 0.5）：矩形带轻微收窄
  if (ny >= 0.1 && ny <= 0.5) {
    const halfWidth = 0.38 - (ny - 0.1) * 0.05;
    return Math.abs(nx - cx) <= halfWidth;
  }

  // 下半部分（0.5 - 0.88）：弧形收窄到底部尖
  if (ny > 0.5 && ny <= 0.88) {
    const t = (ny - 0.5) / 0.38; // 0-1
    const halfWidth = 0.33 * Math.sqrt(1 - t * t);
    return Math.abs(nx - cx) <= halfWidth;
  }

  return false;
}

/** 对勾形状判定 */
function isCheck(nx, ny, size) {
  const thickness = Math.max(0.04, 4 / size);

  // 对勾两段线
  // 第一段：从 (0.3, 0.5) 到 (0.45, 0.65)
  const onLine1 = pointToLineDist(nx, ny, 0.3, 0.5, 0.45, 0.65) <= thickness;

  // 第二段：从 (0.45, 0.65) 到 (0.72, 0.38)
  const onLine2 = pointToLineDist(nx, ny, 0.45, 0.65, 0.72, 0.38) <= thickness;

  // 还需确保点在线段范围内
  const inSeg1 = nx >= 0.28 && nx <= 0.47 && ny >= 0.48 && ny <= 0.67;
  const inSeg2 = nx >= 0.43 && nx <= 0.74 && ny >= 0.36 && ny <= 0.67;

  return (onLine1 && inSeg1) || (onLine2 && inSeg2);
}

function pointToLineDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.hypot(px - projX, py - projY);
}

// 生成三种尺寸
const iconDir = path.join(__dirname, '..', 'icons');
if (!fs.existsSync(iconDir)) fs.mkdirSync(iconDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const png = createPNG(size);
  const filePath = path.join(iconDir, `icon${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`生成: icons/icon${size}.png (${png.length} bytes)`);
}

console.log('图标生成完成');
