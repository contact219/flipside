/** Two cascaded low-pass biquads, cutoff as a fraction of the sample rate. */
function lowpass(x: Float32Array, fc: number): Float32Array {
  const w0 = 2 * Math.PI * fc;
  const alpha = Math.sin(w0) / (2 * 0.7071);
  const cs = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 - cs) / 2 / a0;
  const b1 = (1 - cs) / a0;
  const b2 = b0;
  const a1 = (-2 * cs) / a0;
  const a2 = (1 - alpha) / a0;
  let y = x;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(y.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = y[i];
      const o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = v;
      y2 = y1;
      y1 = o;
      out[i] = o;
    }
    y = out;
  }
  return y;
}

/** Play back at `rate` (2 = twice as fast, an octave up). Output length = input / rate. */
export function resample(input: Float32Array, rate: number): Float32Array {
  if (Math.abs(rate - 1) < 1e-5) return input.slice();
  const x = rate > 1.02 ? lowpass(input, 0.45 / rate) : input;
  const n = x.length;
  const outLen = Math.max(1, Math.round(n / rate));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * rate;
    const i1 = Math.floor(pos);
    const f = pos - i1;
    const p0 = x[i1 > 0 ? i1 - 1 : 0];
    const p1 = i1 < n ? x[i1] : 0;
    const p2 = i1 + 1 < n ? x[i1 + 1] : 0;
    const p3 = i1 + 2 < n ? x[i1 + 2] : 0;
    const c1 = 0.5 * (p2 - p0);
    const c2 = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
    const c3 = 0.5 * (p3 - p0) + 1.5 * (p1 - p2);
    out[i] = ((c3 * f + c2) * f + c1) * f + p1;
  }
  return out;
}

/** Change length without changing pitch (WSOLA). Output length = input * stretch. */
export function wsola(chs: Float32Array[], stretch: number, sr: number): Float32Array[] {
  if (Math.abs(stretch - 1) < 1e-4) return chs.map((c) => c.slice());
  const inLen = chs[0].length;
  const outLen = Math.max(1, Math.round(inLen * stretch));
  const Hs = Math.round(sr * 0.0115);
  const N = Hs * 2;
  const Ha = Hs / stretch;
  const tol = Math.round(sr * 0.012);
  const mono = new Float32Array(inLen);
  for (const c of chs) for (let i = 0; i < inLen; i++) mono[i] += c[i];
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const outs = chs.map(() => new Float32Array(outLen + N));

  const place = (start: number, at: number, first: boolean) => {
    for (let c = 0; c < chs.length; c++) {
      const src = chs[c];
      const dst = outs[c];
      for (let i = 0; i < N; i++) {
        const j = start + i;
        if (j < 0 || j >= inLen) continue;
        dst[at + i] += src[j] * (first && i < Hs ? 1 : win[i]);
      }
    }
  };

  place(0, 0, true);
  let prev = 0;
  for (let k = 1; k * Hs < outLen; k++) {
    const ideal = Math.round(k * Ha);
    const natural = prev + Hs;
    let bestD = 0;
    let bestV = -Infinity;
    for (let d = -tol; d <= tol; d += 2) {
      const cand = ideal + d;
      if (cand < 0 || cand + Hs >= inLen) continue;
      let s = 0;
      let e = 1e-9;
      for (let i = 0; i < Hs; i += 4) {
        const a = mono[cand + i];
        const b = natural + i < inLen ? mono[natural + i] : 0;
        s += a * b;
        e += a * a;
      }
      const v = s / Math.sqrt(e);
      if (v > bestV) {
        bestV = v;
        bestD = d;
      }
    }
    prev = Math.max(0, ideal + bestD);
    place(prev, k * Hs, false);
  }
  return outs.map((o) => o.subarray(0, outLen).slice());
}

/**
 * Pitch and speed together.
 * linked: one resample, pitch follows speed (turntable / tape behaviour).
 * otherwise: pitch in semitones and speed are independent.
 */
export function pitchTime(
  chs: Float32Array[],
  sr: number,
  semis: number,
  tempo: number,
  linked: boolean,
): Float32Array[] {
  if (linked) return chs.map((c) => resample(c, tempo));
  const p = Math.pow(2, semis / 12);
  const stretched = wsola(chs, p / tempo, sr);
  if (Math.abs(p - 1) < 1e-5) return stretched;
  return stretched.map((c) => resample(c, p));
}
