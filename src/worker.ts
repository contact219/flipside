import { beatPhase, detectBpm, detectKey, monoMix, onsetEnvelope } from './dsp/analysis';
import { separate } from './dsp/stems';
import { pitchTime } from './dsp/stretch';

const post = (msg: unknown, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(msg, transfer);

let songL: Float32Array | null = null;
let songR: Float32Array | null = null;
let songSr = 48000;

interface RenderJob {
  L: Float32Array;
  R: Float32Array;
  sr: number;
  semis: number;
  tempo: number;
  linked: boolean;
  reverse: boolean;
  crush: number;
  fadeIn: number;
  fadeOut: number;
  normalize: boolean;
  normGain?: number;
}

function render(d: RenderJob) {
  let chs: Float32Array[] = [d.L, d.R];
  if (d.reverse) chs.forEach((c) => c.reverse());
  chs = pitchTime(chs, d.sr, d.semis, d.tempo, d.linked);
  const n = chs[0].length;

  if (d.crush > 0) {
    const hold = 1 + Math.floor(d.crush * d.crush * 11);
    const levels = Math.pow(2, 16 - d.crush * 10.5) / 2;
    for (const c of chs) {
      let held = 0;
      for (let i = 0; i < n; i++) {
        if (i % hold === 0) held = Math.round(c[i] * levels) / levels;
        c[i] = held;
      }
    }
  }

  let normGain = 1;
  if (d.normGain !== undefined) normGain = d.normGain;
  else if (d.normalize) {
    let peak = 0;
    for (const c of chs) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(c[i]));
    if (peak > 1e-4) normGain = 0.94 / peak;
  }
  if (normGain !== 1) for (const c of chs) for (let i = 0; i < n; i++) c[i] *= normGain;

  // short de-click at both ends, plus any fade the user asked for
  const click = Math.round(d.sr * 0.0015);
  const fi = Math.min(n >> 1, Math.max(click, Math.round((d.fadeIn / 1000) * d.sr)));
  const fo = Math.min(n >> 1, Math.max(click, Math.round((d.fadeOut / 1000) * d.sr)));
  for (const c of chs) {
    for (let i = 0; i < fi; i++) c[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fi);
    for (let i = 0; i < fo; i++) c[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fo);
  }
  return { L: chs[0], R: chs[1], normGain };
}

function analyze(L: Float32Array, R: Float32Array, sr: number, wantKey: boolean) {
  const mono = monoMix(L, R);
  const e = onsetEnvelope(mono, sr);
  const bpm = detectBpm(e.env, e.rate);
  const ph = beatPhase(e, bpm);
  const key = wantKey ? detectKey(mono, sr) : '';
  return { bpm, key, ...ph, env: e.env, rate: e.rate, offset: e.offset };
}

self.onmessage = (ev: MessageEvent) => {
  const { id, op, data } = ev.data;
  try {
    if (op === 'load') {
      songL = data.L;
      songR = data.R;
      songSr = data.sr;
      post({ id, ok: true, result: true });
    } else if (op === 'analyze') {
      const r = data.L ? analyze(data.L, data.R, data.sr, false) : analyze(songL!, songR!, songSr, true);
      post({ id, ok: true, result: r }, [r.env.buffer]);
    } else if (op === 'stems') {
      const r = separate(songL!, songR!, songSr, (p) => post({ id, progress: p }));
      const t = [r.drums, r.bass, r.vocals, r.other].flatMap((s) => [s[0].buffer, s[1].buffer]);
      post({ id, ok: true, result: r }, t);
    } else if (op === 'render') {
      const r = render(data);
      post({ id, ok: true, result: r }, [r.L.buffer, r.R.buffer]);
    } else {
      post({ id, ok: false, error: `unknown op ${op}` });
    }
  } catch (err) {
    post({ id, ok: false, error: String(err) });
  }
};
