/** WAV encoding and a store-only ZIP writer (WAV data barely compresses anyway). */

export function encodeWav(chs: Float32Array[], sr: number, bits: 16 | 24): Uint8Array {
  const n = chs[0].length;
  const nc = chs.length;
  const bytes = bits / 8;
  const dataLen = n * nc * bytes;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + dataLen, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, nc, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * nc * bytes, true);
  dv.setUint16(32, nc * bytes, true);
  dv.setUint16(34, bits, true);
  str(36, 'data');
  dv.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      let s = chs[c][i];
      s = s > 1 ? 1 : s < -1 ? -1 : s;
      if (bits === 16) {
        dv.setInt16(o, Math.round(s * 32767), true);
        o += 2;
      } else {
        const v = Math.round(s * 8388607);
        dv.setUint8(o, v & 255);
        dv.setUint8(o + 1, (v >> 8) & 255);
        dv.setUint8(o + 2, (v >> 16) & 255);
        o += 3;
      }
    }
  }
  return new Uint8Array(buf);
}

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
function crc32(d: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export function makeZip(files: ZipEntry[]): Blob {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, f.data.length, true);
    lh.setUint32(22, f.data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh.buffer as ArrayBuffer, name as BlobPart, f.data as BlobPart);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, f.data.length, true);
    ch.setUint32(24, f.data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    const rec = new Uint8Array(46 + name.length);
    rec.set(new Uint8Array(ch.buffer), 0);
    rec.set(name, 46);
    central.push(rec);
    offset += 30 + name.length + f.data.length;
  }
  let cdSize = 0;
  for (const c of central) {
    parts.push(c as BlobPart);
    cdSize += c.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  parts.push(end.buffer as ArrayBuffer);
  return new Blob(parts, { type: 'application/zip' });
}
