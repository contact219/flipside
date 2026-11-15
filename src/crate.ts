import { encodeWav, makeZip } from './dsp/files';
import type { ZipEntry } from './dsp/files';
import { sliceBounds } from './engine';
import type { CrateItem, Stereo } from './state';

export const crate: CrateItem[] = [];

export const safeName = (s: string) => s.trim().replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'sample';

export function uniqueName(base: string): string {
  let name = safeName(base);
  let i = 2;
  while (crate.some((c) => c.name === name)) name = `${safeName(base)}_${i++}`;
  return name;
}

function cut(st: Stereo, a: number, b: number, sr: number): Stereo {
  const out: Stereo = [st[0].slice(a, b), st[1].slice(a, b)];
  const f = Math.min(Math.round(sr * 0.0015), (b - a) >> 1);
  for (const c of out) {
    for (let i = 0; i < f; i++) {
      c[i] *= i / f;
      c[c.length - 1 - i] *= i / f;
    }
  }
  return out;
}

export function exportZip(bits: 16 | 24): Blob {
  const files: ZipEntry[] = [];
  const enc = new TextEncoder();
  crate.forEach((item, idx) => {
    const dir = `${String(idx + 1).padStart(2, '0')}_${item.name}`;
    files.push({ name: `${dir}/${item.name}.wav`, data: encodeWav(item.full, item.sr, bits) });
    if (item.flip) {
      files.push({ name: `${dir}/${item.name}_flip.wav`, data: encodeWav(item.flip, item.sr, bits) });
    }
    if (item.slices.length > 1) {
      item.slices.forEach((_, i) => {
        const [a, b] = sliceBounds(item.slices, item.bodyLen, i);
        files.push({
          name: `${dir}/slices/${item.name}_slice_${String(i + 1).padStart(2, '0')}.wav`,
          data: encodeWav(cut(item.full, a, b, item.sr), item.sr, bits),
        });
      });
    }
    if (item.stems) {
      for (const [stem, st] of Object.entries(item.stems)) {
        files.push({ name: `${dir}/stems/${item.name}_${stem}.wav`, data: encodeWav(st, item.sr, bits) });
      }
    }
    files.push({ name: `${dir}/${item.name}_info.txt`, data: enc.encode(item.info + '\r\n') });
  });
  return makeZip(files);
}
