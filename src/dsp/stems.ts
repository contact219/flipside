import { FFT } from './fft';

export interface StemResult {
  drums: [Float32Array, Float32Array];
  bass: [Float32Array, Float32Array];
  vocals: [Float32Array, Float32Array];
  other: [Float32Array, Float32Array];
  mono: boolean;
}

/**
 * Signal-processing stem split (no neural network):
 *  - drums:  the percussive part, found with median filtering across time and frequency
 *  - bass:   the sustained part below roughly 200 Hz
 *  - vocals: sustained mid-range content that sits in the centre of the stereo image
 *  - other:  whatever is left, so the four stems always add back up to the song
 */
export function separate(
  L: Float32Array,
  R: Float32Array,
  sr: number,
  progress: (p: number) => void,
): StemResult {
  const len = L.length;
  const N = 4096;
  const HOP = 1024;
  const K = 17;
  const HALF = 8;
  const B = N / 2 + 1;
  const fft = new FFT(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const mk = () => Array.from({ length: K }, () => new Float32Array(B));
  const lre = mk();
  const lim = mk();
  const rre = mk();
  const rim = mk();
  const mag = mk();

  const dL = new Float32Array(len);
  const dR = new Float32Array(len);
  const bL = new Float32Array(len);
  const bR = new Float32Array(len);
  const v = new Float32Array(len);

  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const tmp = new Float32Array(K);
  const mh = new Float32Array(B);
  const wgt = new Float32Array(B);
  const midRe = new Float32Array(B);
  const midIm = new Float32Array(B);

  const wb = new Float32Array(B);
  const wv = new Float32Array(B);
  const ramp = (f: number, a: number, b: number) =>
    f <= a ? 0 : f >= b ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * (f - a)) / (b - a));
  for (let k = 0; k < B; k++) {
    const f = (k * sr) / N;
    wb[k] = 1 - ramp(f, 120, 260);
    wv[k] = ramp(f, 180, 320) * (1 - ramp(f, 6000, 9000));
  }

  let diff = 0;
  let tot = 1e-12;
  for (let i = 0; i < len; i += 7) {
    const d = L[i] - R[i];
    diff += d * d;
    tot += L[i] * L[i] + R[i] * R[i];
  }
  const mono = diff / tot < 1e-4;

  const median = (): number => {
    for (let i = 1; i < K; i++) {
      const x = tmp[i];
      let j = i - 1;
      while (j >= 0 && tmp[j] > x) {
        tmp[j + 1] = tmp[j];
        j--;
      }
      tmp[j + 1] = x;
    }
    return tmp[HALF];
  };

  const analyze = (x: Float32Array, s: number, oRe: Float32Array, oIm: Float32Array) => {
    for (let i = 0; i < N; i++) {
      const j = s + i;
      re[i] = j >= 0 && j < len ? x[j] * win[i] : 0;
      im[i] = 0;
    }
    fft.transform(re, im);
    for (let k = 0; k < B; k++) {
      oRe[k] = re[k];
      oIm[k] = im[k];
    }
  };

  const norm = 1 / 1.5;
  const synth = (sRe: Float32Array, sIm: Float32Array, w: Float32Array, dst: Float32Array, s: number) => {
    for (let k = 0; k < B; k++) {
      re[k] = sRe[k] * w[k];
      im[k] = sIm[k] * w[k];
    }
    for (let k = 1; k < N / 2; k++) {
      re[N - k] = re[k];
      im[N - k] = -im[k];
    }
    fft.transform(re, im, true);
    const a = Math.max(0, -s);
    const b = Math.min(N, len - s);
    for (let i = a; i < b; i++) dst[s + i] += re[i] * win[i] * norm;
  };

  const dataFrames = Math.floor((len - 1 + N - HOP) / HOP) + 1;
  const total = dataFrames + HALF;
  for (let f = 0; f < total; f++) {
    const slot = f % K;
    const s = f * HOP - (N - HOP);
    analyze(L, s, lre[slot], lim[slot]);
    analyze(R, s, rre[slot], rim[slot]);
    const m = mag[slot];
    const a1 = lre[slot];
    const a2 = lim[slot];
    const a3 = rre[slot];
    const a4 = rim[slot];
    for (let k = 0; k < B; k++) {
      m[k] = Math.sqrt(0.5 * (a1[k] * a1[k] + a2[k] * a2[k] + a3[k] * a3[k] + a4[k] * a4[k]));
    }
    const c = f - HALF;
    if (c < 0) continue;
    const cs = c % K;
    const sc = c * HOP - (N - HOP);
    const cm = mag[cs];
    for (let k = 0; k < B; k++) {
      for (let j = 0; j < K; j++) tmp[j] = mag[j][k];
      const h = median();
      for (let j = 0; j < K; j++) {
        const q = k - HALF + j;
        tmp[j] = cm[q < 0 ? 0 : q >= B ? B - 1 : q];
      }
      const p = median();
      mh[k] = (h * h) / (h * h + p * p + 1e-20);
    }
    const LR = lre[cs];
    const LI = lim[cs];
    const RR = rre[cs];
    const RI = rim[cs];

    for (let k = 0; k < B; k++) wgt[k] = 1 - mh[k];
    synth(LR, LI, wgt, dL, sc);
    synth(RR, RI, wgt, dR, sc);

    for (let k = 0; k < B; k++) wgt[k] = mh[k] * wb[k];
    synth(LR, LI, wgt, bL, sc);
    synth(RR, RI, wgt, bR, sc);

    if (!mono) {
      for (let k = 0; k < B; k++) {
        const e = LR[k] * LR[k] + LI[k] * LI[k] + RR[k] * RR[k] + RI[k] * RI[k] + 1e-20;
        let cen = (2 * (LR[k] * RR[k] + LI[k] * RI[k])) / e;
        cen = cen < 0 ? 0 : cen > 1 ? 1 : cen;
        cen *= cen;
        cen *= cen;
        wgt[k] = mh[k] * (1 - wb[k]) * wv[k] * cen;
        midRe[k] = 0.5 * (LR[k] + RR[k]);
        midIm[k] = 0.5 * (LI[k] + RI[k]);
      }
      synth(midRe, midIm, wgt, v, sc);
    }
    if ((f & 31) === 0) progress(f / total);
  }

  const oL = new Float32Array(len);
  const oR = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    oL[i] = L[i] - dL[i] - bL[i] - v[i];
    oR[i] = R[i] - dR[i] - bR[i] - v[i];
  }
  progress(1);
  return { drums: [dL, dR], bass: [bL, bR], vocals: [v, v.slice()], other: [oL, oR], mono };
}
