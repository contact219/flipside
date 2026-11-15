import type { Params } from './state';

function impulse(ctx: BaseAudioContext): AudioBuffer {
  const len = Math.round(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  let seed = 1234567;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      d[i] = rnd() * Math.pow(1 - t, 3) * Math.exp(-t * 3) * 0.5;
    }
  }
  return buf;
}

function driveCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const k = 1 + amount * 24;
  const c = new Float32Array(new ArrayBuffer(n * 4));
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}

/** The filter chain. Built the same way for live playback and for export. */
export function buildFx(ctx: BaseAudioContext, p: Params) {
  const input = ctx.createGain();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  const shaper = ctx.createWaveShaper();
  shaper.oversample = '2x';
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const conv = ctx.createConvolver();
  conv.buffer = impulse(ctx);
  const out = ctx.createGain();
  input.connect(hp).connect(lp).connect(shaper);
  shaper.connect(dry).connect(out);
  shaper.connect(conv).connect(wet).connect(out);

  let lastDrive = -1;
  const update = (q: Params) => {
    const top = ctx.sampleRate / 2 - 200;
    hp.frequency.value = q.hp;
    hp.Q.value = -3; // dB; -3 is the flat (Butterworth) response
    lp.frequency.value = Math.min(q.lp, top);
    lp.Q.value = -3 + q.res;
    if (q.drive !== lastDrive) {
      shaper.curve = q.drive > 0 ? driveCurve(q.drive) : null;
      lastDrive = q.drive;
    }
    wet.gain.value = q.reverb * 0.9;
    dry.gain.value = 1 - q.reverb * 0.35;
    out.gain.value = Math.pow(10, q.gain / 20);
  };
  update(p);
  return { input, out, update };
}
