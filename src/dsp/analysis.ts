import { FFT } from './fft';

export function monoMix(L: Float32Array, R: Float32Array): Float32Array {
  const m = new Float32Array(L.length);
  for (let i = 0; i < m.length; i++) m[i] = 0.5 * (L[i] + R[i]);
  return m;
}

export interface Envelope {
  env: Float32Array;
  low: Float32Array; // onset strength of the low end only (kick drum territory)
  rate: number;
  offset: number;
}

/** Onset strength (spectral flux) with the slow-moving average removed. */
export function onsetEnvelope(mono: Float32Array, sr: number, hop = 256, size = 1024): Envelope {
  const n = Math.max(0, Math.floor((mono.length - size) / hop) + 1);
  const raw = new Float32Array(n);
  const low = new Float32Array(n);
  const lowBins = Math.max(2, Math.ceil((160 * size) / sr));
  const fft = new FFT(size);
  const win = new Float64Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const prev = new Float32Array(size / 2);
  for (let t = 0; t < n; t++) {
    const s = t * hop;
    for (let i = 0; i < size; i++) {
      re[i] = mono[s + i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    let flux = 0;
    let lf = 0;
    for (let k = 1; k < size / 2; k++) {
      const m = Math.log1p(Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      const d = m - prev[k];
      if (d > 0) {
        flux += d;
        if (k <= lowBins) lf += d;
      }
      prev[k] = m;
    }
    raw[t] = t === 0 ? 0 : flux;
    low[t] = t === 0 ? 0 : lf;
  }
  const rate = sr / hop;
  const w = Math.max(1, Math.round(0.4 * rate));
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + raw[i];
  const env = new Float32Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(n, i + w + 1);
    const v = raw[i] - (pre[b] - pre[a]) / (b - a);
    env[i] = v > 0 ? v : 0;
    if (env[i] > max) max = env[i];
  }
  if (max > 0) for (let i = 0; i < n; i++) env[i] /= max;
  return { env, low, rate, offset: (size / 2 - hop / 2) / sr - 0.004 };
}

export function detectBpm(env: Float32Array, rate: number, lo = 70, hi = 180): number {
  const n = env.length;
  if (n < rate * 1.5) return 0;
  const cache = new Map<number, number>();
  const acf = (l: number): number => {
    if (l >= n - 8) return 0;
    let v = cache.get(l);
    if (v !== undefined) return v;
    let s = 0;
    for (let i = 0; i < n - l; i++) s += env[i] * env[i + l];
    v = s / (n - l);
    cache.set(l, v);
    return v;
  };
  const lmin = Math.max(2, Math.floor((rate * 60) / hi));
  const lmax = Math.ceil((rate * 60) / lo);
  let best = lmin;
  let bestScore = -1;
  for (let l = lmin; l <= lmax; l++) {
    const bpm = (60 * rate) / l;
    const z = Math.log2(bpm / 110) / 0.7;
    const prior = Math.exp(-0.5 * z * z);
    const sc = (acf(l) + 0.5 * acf(2 * l) + 0.25 * acf(4 * l)) * prior;
    if (sc > bestScore) {
      bestScore = sc;
      best = l;
    }
  }
  let lag = best;
  for (const m of [8, 4, 2, 1]) {
    if (m * best * 1.3 >= n) continue;
    const c = m * best;
    let pk = c;
    let pv = -1;
    for (let l = c - m; l <= c + m; l++) {
      const v = acf(l);
      if (v > pv) {
        pv = v;
        pk = l;
      }
    }
    const a = acf(pk - 1);
    const b = acf(pk + 1);
    const den = a - 2 * pv + b;
    const shift = den !== 0 ? (0.5 * (a - b)) / den : 0;
    lag = (pk + Math.max(-1, Math.min(1, shift))) / m;
    break;
  }
  let bpm = (60 * rate) / lag;
  if (Math.abs(bpm - Math.round(bpm)) < 0.15) bpm = Math.round(bpm);
  return Math.round(bpm * 10) / 10;
}

/** Where the beats and (a best guess at) the bar lines sit. */
export function beatPhase(e: Envelope, bpm: number): { beatOffset: number; barOffset: number } {
  const { env, low, rate, offset } = e;
  if (!bpm || env.length < 4) return { beatOffset: 0, barOffset: 0 };
  const P = (rate * 60) / bpm;
  const at = (x: number): number => {
    const i = Math.round(x);
    return i >= 0 && i < env.length ? env[i] : 0;
  };
  let bestPhi = 0;
  let bestV = -1;
  for (let phi = 0; phi < P; phi++) {
    let s = 0;
    for (let x = phi; x < env.length; x += P) s += at(x) + 0.5 * (at(x - 1) + at(x + 1));
    if (s > bestV) {
      bestV = s;
      bestPhi = phi;
    }
  }
  // bar lines: the beat of the bar where the low end hits hardest is most likely the one
  const lowAt = (x: number): number => {
    const i = Math.round(x);
    let m = 0;
    for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < low.length && low[j] > m) m = low[j];
    return m;
  };
  let bestJ = 0;
  bestV = -1;
  for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let x = bestPhi + j * P; x < env.length; x += 4 * P) s += lowAt(x);
    if (s > bestV) {
      bestV = s;
      bestJ = j;
    }
  }
  return { beatOffset: bestPhi / rate + offset, barOffset: (bestPhi + bestJ * P) / rate + offset };
}

export interface Onset {
  t: number; // seconds
  s: number; // strength 0..1
}

export function findOnsets(e: Envelope, minGap = 0.05, floor = 0.06): Onset[] {
  const { env, rate, offset } = e;
  const w = Math.max(1, Math.round(minGap * rate));
  const out: Onset[] = [];
  for (let i = 1; i < env.length - 1; i++) {
    const v = env[i];
    if (v < floor) continue;
    let peak = true;
    for (let j = Math.max(0, i - w); j <= Math.min(env.length - 1, i + w); j++) {
      if (env[j] > v || (env[j] === v && j < i)) {
        peak = false;
        break;
      }
    }
    if (peak) out.push({ t: Math.max(0, i / rate + offset), s: v });
  }
  return out;
}

const NOTE = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export function detectKey(mono: Float32Array, sr: number): string {
  const N = 16384;
  if (mono.length < N) return '';
  const fft = new FFT(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const k0 = Math.ceil((65 * N) / sr);
  const k1 = Math.floor((2000 * N) / sr);
  const pc = new Int8Array(k1 + 1);
  for (let k = k0; k <= k1; k++) {
    const midi = Math.round(69 + 12 * Math.log2((k * sr) / N / 440));
    pc[k] = ((midi % 12) + 12) % 12;
  }
  const frames = Math.min(160, Math.floor(mono.length / N));
  const stride = Math.floor((mono.length - N) / Math.max(1, frames - 1)) || 1;
  const chroma = new Float64Array(12);
  for (let f = 0; f < frames; f++) {
    const s = Math.min(mono.length - N, f * stride);
    for (let i = 0; i < N; i++) {
      re[i] = mono[s + i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    for (let k = k0; k <= k1; k++) chroma[pc[k]] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }
  const corr = (profile: number[], root: number): number => {
    let mx = 0;
    let my = 0;
    for (let i = 0; i < 12; i++) {
      mx += chroma[(i + root) % 12];
      my += profile[i];
    }
    mx /= 12;
    my /= 12;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < 12; i++) {
      const a = chroma[(i + root) % 12] - mx;
      const b = profile[i] - my;
      num += a * b;
      dx += a * a;
      dy += b * b;
    }
    return num / (Math.sqrt(dx * dy) || 1);
  };
  let best = '';
  let bv = -2;
  for (let r = 0; r < 12; r++) {
    const a = corr(MAJ, r);
    if (a > bv) {
      bv = a;
      best = `${NOTE[r]} major`;
    }
    const b = corr(MIN, r);
    if (b > bv) {
      bv = b;
      best = `${NOTE[r]} minor`;
    }
  }
  return best;
}

export function transposeKey(key: string, semis: number): string {
  if (!key) return '';
  const [name, mode] = key.split(' ');
  const i = NOTE.indexOf(name);
  if (i < 0) return key;
  const j = (((i + Math.round(semis)) % 12) + 12) % 12;
  return `${NOTE[j]} ${mode}`;
}
