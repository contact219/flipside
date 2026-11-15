import { findOnsets, monoMix, onsetEnvelope, transposeKey } from './dsp/analysis';
import { buildFx } from './fx';
import { DEFAULTS, STEMS } from './state';
import type { Analysis, CrateItem, Params, StemName, Stereo } from './state';

/* ---------- tiny event bus ---------- */
type Fn = (arg?: any) => void;
const subs = new Map<string, Fn[]>();
export function on(ev: string, fn: Fn) {
  subs.set(ev, [...(subs.get(ev) ?? []), fn]);
}
export function emit(ev: string, arg?: any) {
  (subs.get(ev) ?? []).forEach((f) => f(arg));
}
export const status = (msg: string) => emit('status', msg);

/* ---------- state ---------- */
export const P: Params = { ...DEFAULTS };
export const S = {
  source: null as { name: string; ch: Stereo; duration: number } | null,
  analysis: null as Analysis | null,
  stems: null as Record<StemName, Stereo> | null,
  stemsMono: false,
  stemOn: { drums: true, bass: true, vocals: true, other: true } as Record<StemName, boolean>,
  stemGain: { drums: 1, bass: 1, vocals: 1, other: 1 } as Record<StemName, number>,
  splitting: false,
  splitKind: 'quick' as 'ai' | 'quick',
  stemKind: 'quick' as 'ai' | 'quick',
  rendered: null as Stereo | null,
  renderedBuf: null as AudioBuffer | null,
  normGain: 1,
  slices: [0] as number[],
  slicesLen: 0,
  order: [0] as number[],
  playing: false,
  playMode: 'sample' as 'sample' | 'flip',
  refMode: 'off' as 'off' | 'click' | 'drums',
  drum: null as { name: string; buffer: AudioBuffer; bpm: number } | null,
  targetTouched: false,
};

export const ctx = new AudioContext({ latencyHint: 'interactive' });
const live = buildFx(ctx, P);
live.out.connect(ctx.destination);
const refGain = ctx.createGain();
refGain.gain.value = 0.7;
refGain.connect(ctx.destination);
export const updateFx = () => live.update(P);

/* ---------- worker ---------- */
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let rpcSeq = 0;
const pending = new Map<number, { res: Fn; rej: Fn; prog?: (p: number) => void }>();
worker.onmessage = (e) => {
  const m = e.data;
  const p = pending.get(m.id);
  if (!p) return;
  if (m.progress !== undefined) {
    p.prog?.(m.progress);
    return;
  }
  pending.delete(m.id);
  if (m.ok) p.res(m.result);
  else p.rej(new Error(m.error));
};
function rpc<T = any>(op: string, data: any, transfer: Transferable[] = [], prog?: (p: number) => void): Promise<T> {
  return new Promise((res, rej) => {
    const id = ++rpcSeq;
    pending.set(id, { res, rej, prog });
    worker.postMessage({ id, op, data }, transfer);
  });
}

/* ---------- derived values ---------- */
export const effSemis = () => (P.linked ? 12 * Math.log2(P.tempo) : P.semis + P.cents / 100);
export const effBpm = () => (S.analysis ? S.analysis.bpm * P.tempo : 0);
export const keyNow = () => (S.analysis ? transposeKey(S.analysis.key, effSemis()) : '');
export const beatLen = () => (S.analysis && S.analysis.bpm > 0 ? 60 / S.analysis.bpm : 0);

/* ---------- loading ---------- */
export async function loadFile(file: File) {
  status(`Opening ${file.name}…`);
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    status(`Can't read ${file.name}. Use a WAV, MP3, FLAC, OGG or M4A file.`);
    return;
  }
  const L = buf.getChannelData(0).slice();
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice() : L.slice();
  await loadStereo(file.name.replace(/\.[^.]+$/, ''), [L, R]);
}

export async function loadStereo(name: string, ch: Stereo) {
  stop();
  const sr = ctx.sampleRate;
  S.source = { name, ch, duration: ch[0].length / sr };
  S.stems = null;
  S.analysis = null;
  S.rendered = null;
  S.renderedBuf = null;
  S.slices = [0];
  S.order = [0];
  for (const s of STEMS) {
    S.stemOn[s] = true;
    S.stemGain[s] = 1;
  }
  Object.assign(P, DEFAULTS, { targetBpm: P.targetBpm, bars: P.bars, snap: P.snap });
  P.start = 0;
  P.end = Math.min(S.source.duration, 8);
  emit('source');
  status('Finding the tempo and key…');
  await rpc('load', { L: ch[0], R: ch[1], sr });
  S.analysis = await rpc<Analysis>('analyze', {});
  if (!S.targetTouched && !S.drum && S.analysis.bpm > 0) P.targetBpm = Math.round(S.analysis.bpm);
  findLoop('best');
  emit('analysis');
  status('');
  await renderNow();
}

export async function loadDrums(file: File) {
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    status(`Can't read ${file.name}.`);
    return;
  }
  const L = buf.getChannelData(0).slice();
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice() : L.slice();
  const an = await rpc<Analysis>('analyze', { L, R, sr: buf.sampleRate }, [L.buffer, R.buffer]);
  // A drum loop is almost always a whole number of bars, which pins the tempo down exactly.
  let bpm = an.bpm;
  let best = Infinity;
  for (const bars of [1, 2, 4, 8, 16]) {
    const cand = (bars * 240) / buf.duration;
    const d = Math.abs(Math.log2(cand / (an.bpm || 100)));
    if (cand >= 60 && cand <= 200 && d < best && d < 0.06) {
      best = d;
      bpm = Math.round(cand * 10) / 10;
    }
  }
  S.drum = { name: file.name, buffer: buf, bpm };
  if (bpm > 0) P.targetBpm = bpm;
  S.refMode = 'drums';
  emit('drum');
  if (S.playing) play();
}

/* ---------- stems ---------- */
const AI_URL = 'http://127.0.0.1:8765';

/** Is the local Demucs server running, and has it finished loading its model? */
export async function aiStatus(): Promise<'ready' | 'loading' | 'off'> {
  try {
    const r = await fetch(`${AI_URL}/health`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j.ready ? 'ready' : j.error ? 'off' : 'loading';
  } catch {
    return 'off';
  }
}

async function aiSplit(): Promise<Record<StemName, Stereo>> {
  const [L, R] = S.source!.ch;
  const n = L.length;
  const body = new Float32Array(n * 2);
  body.set(L, 0);
  body.set(R, n);
  const poll = window.setInterval(async () => {
    try {
      const j = await (await fetch(`${AI_URL}/progress`)).json();
      emit('stemProgress', j.p);
    } catch {
      /* keep waiting */
    }
  }, 800);
  try {
    const res = await fetch(`${AI_URL}/separate?sr=${ctx.sampleRate}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
    if (!res.ok) throw new Error((await res.json()).error ?? `Stem server error ${res.status}`);
    const all = new Float32Array(await res.arrayBuffer());
    if (all.length !== n * 8) throw new Error('The stem server sent back the wrong amount of audio.');
    const out = {} as Record<StemName, Stereo>;
    STEMS.forEach((s, i) => {
      out[s] = [all.slice(i * 2 * n, (i * 2 + 1) * n), all.slice((i * 2 + 1) * n, (i * 2 + 2) * n)];
    });
    return out;
  } finally {
    clearInterval(poll);
  }
}

export async function splitStems(kind: 'ai' | 'quick' = 'quick') {
  if (!S.source || S.splitting) return;
  const song = S.source;
  S.splitting = true;
  S.splitKind = kind;
  emit('stemProgress', 0);
  emit('stems');
  try {
    if (kind === 'ai') {
      const stems = await aiSplit();
      if (S.source !== song) return;
      S.stems = stems;
      S.stemsMono = false;
    } else {
      const r = await rpc('stems', {}, [], (p) => emit('stemProgress', p));
      if (S.source !== song) return;
      S.stems = { drums: r.drums, bass: r.bass, vocals: r.vocals, other: r.other };
      S.stemsMono = r.mono;
    }
    S.stemKind = kind;
    scheduleRender();
  } finally {
    S.splitting = false;
    emit('stems');
  }
}

function regionSamples(): [number, number] {
  const sr = ctx.sampleRate;
  const n = S.source!.ch[0].length;
  const a = Math.max(0, Math.min(n - 2, Math.floor(P.start * sr)));
  const b = Math.max(a + 1, Math.min(n, Math.floor(P.end * sr)));
  return [a, b];
}

export function regionMix(only?: StemName): Stereo {
  const [a, b] = regionSamples();
  const src = S.source!.ch;
  if (only && S.stems) return [S.stems[only][0].slice(a, b), S.stems[only][1].slice(a, b)];
  const neutral = STEMS.every((s) => S.stemOn[s] && S.stemGain[s] === 1);
  if (!S.stems || neutral) return [src[0].slice(a, b), src[1].slice(a, b)];
  const out: Stereo = [new Float32Array(b - a), new Float32Array(b - a)];
  for (const s of STEMS) {
    const g = S.stemOn[s] ? S.stemGain[s] : 0;
    if (g === 0) continue;
    for (let c = 0; c < 2; c++) {
      const from = S.stems[s][c];
      const to = out[c];
      for (let i = 0; i < to.length; i++) to[i] += from[a + i] * g;
    }
  }
  return out;
}

/* ---------- rendering the sample ---------- */
function job(st: Stereo, normGain?: number) {
  return {
    L: st[0],
    R: st[1],
    sr: ctx.sampleRate,
    semis: P.semis + P.cents / 100,
    tempo: P.tempo,
    linked: P.linked,
    reverse: P.reverse,
    crush: P.crush,
    fadeIn: P.fadeIn,
    fadeOut: P.fadeOut,
    normalize: P.normalize,
    normGain,
  };
}

let renderSeq = 0;
let renderTimer = 0;
export function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(renderNow, 110);
}

export async function renderNow() {
  if (!S.source) return;
  clearTimeout(renderTimer);
  const id = ++renderSeq;
  const st = regionMix();
  const r = await rpc('render', job(st), [st[0].buffer, st[1].buffer]);
  if (id !== renderSeq) return;
  S.rendered = [r.L, r.R];
  S.normGain = r.normGain;
  const buf = ctx.createBuffer(2, r.L.length, ctx.sampleRate);
  buf.getChannelData(0).set(r.L);
  buf.getChannelData(1).set(r.R);
  S.renderedBuf = buf;
  recomputeSlices();
  emit('rendered');
  if (S.playing) play();
}

/* ---------- slicing ---------- */
export function recomputeSlices(resetOrder = false) {
  const r = S.rendered;
  if (!r) return;
  const n = r[0].length;
  const sr = ctx.sampleRate;
  const prevCount = S.slices.length;
  let sl: number[] = [0];
  const count = Math.max(1, Math.round(P.chopCount));
  if (P.chopMode === 'equal') {
    for (let i = 1; i < count; i++) sl.push(Math.round((i * n) / count));
  } else if (P.chopMode === 'beat') {
    const bpm = effBpm();
    if (bpm > 0) {
      const step = (60 / bpm) * sr;
      for (let t = step; t < n - step * 0.25; t += step) sl.push(Math.round(t));
    }
  } else if (P.chopMode === 'transient') {
    const e = onsetEnvelope(monoMix(r[0], r[1]), sr, 128, 512);
    const edge = 0.03 * sr;
    const ons = findOnsets(e, 0.04)
      .map((o) => ({ pos: Math.round(o.t * sr), s: o.s }))
      .filter((o) => o.pos > edge && o.pos < n - edge)
      .sort((a, b) => b.s - a.s);
    const minGap = Math.max(edge, n / count / 6);
    const picked: number[] = [];
    for (const o of ons) {
      if (picked.length >= count - 1) break;
      if (picked.every((p) => Math.abs(p - o.pos) > minGap)) picked.push(o.pos);
    }
    sl = [0, ...picked.sort((a, b) => a - b)];
  } else {
    const k = S.slicesLen ? n / S.slicesLen : 1;
    sl = S.slices.map((x) => Math.round(x * k)).filter((x, i) => i === 0 || (x > 0 && x < n));
  }
  S.slices = sl;
  S.slicesLen = n;
  if (resetOrder || sl.length !== prevCount || S.order.length !== sl.length) S.order = sl.map((_, i) => i);
  emit('slices');
}

export const isIdentity = (order: number[]) => order.every((v, i) => v === i);

export function sliceBounds(slices: number[], n: number, i: number): [number, number] {
  return [slices[i], i + 1 < slices.length ? slices[i + 1] : n];
}

/** Glue slices together in a new order. */
export function buildFlip(st: Stereo, slices: number[], order: number[], n: number, sr: number) {
  const map: { at: number; src: number; len: number }[] = [];
  let total = 0;
  for (const i of order) {
    const [a, b] = sliceBounds(slices, n, i);
    map.push({ at: total, src: a, len: b - a });
    total += b - a;
  }
  const out: Stereo = [new Float32Array(total), new Float32Array(total)];
  const fade = Math.round(sr * 0.0015);
  for (const seg of map) {
    const f = Math.min(fade, seg.len >> 1);
    for (let c = 0; c < 2; c++) {
      const d = out[c];
      d.set(st[c].subarray(seg.src, seg.src + seg.len), seg.at);
      for (let i = 0; i < f; i++) {
        const g = i / f;
        d[seg.at + i] *= g;
        d[seg.at + seg.len - 1 - i] *= g;
      }
    }
  }
  return { st: out, map };
}

/* ---------- playback ---------- */
let node: AudioBufferSourceNode | null = null;
let refNode: AudioBufferSourceNode | null = null;
let t0 = 0;
let playDur = 0;
let playLoop = false;
let flipMap: { at: number; src: number; len: number }[] | null = null;

function clickBuffer(): AudioBuffer {
  const sr = ctx.sampleRate;
  const beat = 60 / Math.max(30, P.targetBpm);
  const len = Math.round(beat * 4 * sr);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  for (let b = 0; b < 4; b++) {
    const a = Math.round(b * beat * sr);
    const f = b === 0 ? 1600 : 1000;
    for (let i = 0; i < sr * 0.03 && a + i < len; i++) {
      d[a + i] = Math.sin((2 * Math.PI * f * i) / sr) * Math.exp((-i / sr) * 120) * 0.6;
    }
  }
  return buf;
}

export function stop() {
  for (const n of [node, refNode]) {
    if (!n) continue;
    n.onended = null;
    try {
      n.stop();
    } catch {
      /* already stopped */
    }
    n.disconnect();
  }
  node = refNode = null;
  if (S.playing) {
    S.playing = false;
    emit('play');
  }
}

function startNode(buf: AudioBuffer, loop: boolean, offset = 0, dur?: number): number {
  const n = ctx.createBufferSource();
  n.buffer = buf;
  n.loop = loop;
  n.connect(live.input);
  const when = ctx.currentTime + 0.04;
  if (dur !== undefined) n.start(when, offset, dur);
  else n.start(when, offset);
  n.onended = () => {
    if (node === n) stop();
  };
  node = n;
  return when;
}

export function play(mode: 'sample' | 'flip' = S.playMode) {
  if (!S.renderedBuf || !S.rendered) return;
  stop();
  void ctx.resume();
  S.playMode = mode;
  let buf = S.renderedBuf;
  flipMap = null;
  if (mode === 'flip') {
    const f = buildFlip(S.rendered, S.slices, S.order, S.rendered[0].length, ctx.sampleRate);
    buf = ctx.createBuffer(2, Math.max(1, f.st[0].length), ctx.sampleRate);
    buf.getChannelData(0).set(f.st[0]);
    buf.getChannelData(1).set(f.st[1]);
    flipMap = f.map;
  }
  const when = startNode(buf, P.loop);
  t0 = when;
  playDur = buf.duration;
  playLoop = P.loop;
  const ref = S.refMode === 'click' ? clickBuffer() : S.refMode === 'drums' ? S.drum?.buffer : null;
  if (ref) {
    refNode = ctx.createBufferSource();
    refNode.buffer = ref;
    refNode.loop = true;
    refNode.connect(refGain);
    refNode.start(when);
  }
  S.playing = true;
  emit('play');
}

export function playSlice(i: number) {
  if (!S.renderedBuf || !S.rendered) return;
  stop();
  void ctx.resume();
  flipMap = null;
  const sr = ctx.sampleRate;
  const [a, b] = sliceBounds(S.slices, S.rendered[0].length, i);
  const when = startNode(S.renderedBuf, false, a / sr, (b - a) / sr);
  t0 = when - a / sr;
  playDur = b / sr;
  playLoop = false;
  S.playing = true;
  emit('play');
}

export function setLoopLive() {
  if (node && playLoop !== P.loop && S.playing) play();
}

/** Position in the rendered sample, in seconds, or -1 when nothing is playing. */
export function playhead(): number {
  if (!S.playing || !node) return -1;
  let pos = ctx.currentTime - t0;
  if (pos < 0) return 0;
  if (playLoop) pos %= playDur;
  else if (pos > playDur) return -1;
  if (flipMap) {
    const sr = ctx.sampleRate;
    const x = pos * sr;
    const seg = flipMap.find((m) => x >= m.at && x < m.at + m.len);
    return seg ? (seg.src + (x - seg.at)) / sr : -1;
  }
  return pos;
}

/* ---------- selection helpers ---------- */
export function setRegion(a: number, b: number) {
  if (!S.source) return;
  const d = S.source.duration;
  const len = Math.min(d, Math.max(0.02, b - a));
  a = Math.max(0, Math.min(d - len, a));
  P.start = a;
  P.end = a + len;
  emit('region');
  scheduleRender();
}

export function snapTime(t: number): number {
  const T = beatLen();
  if (!P.snap || !T || !S.analysis) return t;
  return S.analysis.beatOffset + Math.round((t - S.analysis.beatOffset) / T) * T;
}

interface LoopCand {
  start: number;
  score: number;
}

function loopCandidates(bars: number): { list: LoopCand[]; len: number } {
  const an = S.analysis;
  const src = S.source;
  if (!an || !src || an.bpm <= 0) return { list: [], len: 0 };
  const T = 60 / an.bpm;
  const len = bars * 4 * T;
  const { env, rate, offset } = an;
  const w = Math.round(2 * T * rate);
  const list: LoopCand[] = [];
  const k0 = Math.ceil((0.001 - an.barOffset) / T);
  for (let k = k0; ; k++) {
    const start = an.barOffset + k * T;
    if (start + len > src.duration) break;
    const a = Math.round((start - offset) * rate);
    const b = Math.round((start + len - offset) * rate);
    let sxy = 0;
    let sxx = 1e-9;
    let syy = 1e-9;
    let energy = 0;
    for (let i = 0; i < w; i++) {
      const x = env[a + i] ?? 0;
      const y = env[b + i] ?? 0;
      sxy += x * y;
      sxx += x * x;
      syy += y * y;
    }
    for (let i = a; i < b; i += 4) energy += env[i] ?? 0;
    const density = (energy * 4) / Math.max(1, b - a);
    if (density < 0.004) continue; // near silence
    let attack = 0;
    for (let i = -2; i <= 2; i++) attack = Math.max(attack, env[a + i] ?? 0);
    const onBar = ((k % 4) + 4) % 4 === 0 ? 0.3 : 0;
    list.push({ start, score: sxy / Math.sqrt(sxx * syy) + 0.35 * attack + onBar });
  }
  return { list, len };
}

/** Pick a loop that starts on a beat and comes back around cleanly. */
export function findLoop(mode: 'best' | 'near' | 'any', bars = P.bars): boolean {
  const { list, len } = loopCandidates(bars);
  if (!S.source) return false;
  if (!list.length) {
    if (mode === 'best') setRegion(0, Math.min(S.source.duration, 8));
    return false;
  }
  let pick: LoopCand;
  if (mode === 'near') {
    const near = list.filter((c) => c.start >= P.start - len && c.start <= P.end);
    const pool = near.length ? near : list;
    pick = pool.reduce((a, b) => (b.score > a.score ? b : a));
  } else if (mode === 'any') {
    const sorted = [...list].sort((a, b) => b.score - a.score);
    const top = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 3)));
    const others = top.filter((c) => Math.abs(c.start - P.start) > 0.01);
    const pool = others.length ? others : top;
    pick = pool[Math.floor(Math.random() * pool.length)];
  } else {
    pick = list.reduce((a, b) => (b.score > a.score ? b : a));
  }
  P.loop = true;
  setRegion(pick.start, pick.start + len);
  return true;
}

/* ---------- beat matching ---------- */
export function matchTempo(): boolean {
  const bpm = S.analysis?.bpm ?? 0;
  if (!bpm || !P.targetBpm) return false;
  let r = P.targetBpm / bpm;
  while (r > Math.SQRT2) r /= 2;
  while (r < Math.SQRT1_2) r *= 2;
  P.tempo = r;
  scheduleRender();
  return true;
}

export function fitBars(): boolean {
  if (!P.targetBpm) return false;
  const want = (P.bars * 240) / P.targetBpm;
  const r = (P.end - P.start) / want;
  if (r < 0.5 || r > 2) return false;
  P.tempo = r;
  scheduleRender();
  return true;
}

/* ---------- export ---------- */
async function applyFx(st: Stereo, tail: number): Promise<Stereo> {
  const sr = ctx.sampleRate;
  const len = st[0].length + Math.round(tail * sr);
  const oc = new OfflineAudioContext(2, len, sr);
  const buf = oc.createBuffer(2, st[0].length, sr);
  buf.getChannelData(0).set(st[0]);
  buf.getChannelData(1).set(st[1]);
  const src = oc.createBufferSource();
  src.buffer = buf;
  const fx = buildFx(oc, P);
  src.connect(fx.input);
  fx.out.connect(oc.destination);
  src.start();
  const out = await oc.startRendering();
  return [out.getChannelData(0).slice(), out.getChannelData(1).slice()];
}

function peakOf(st: Stereo): number {
  let p = 0;
  for (const c of st) for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i]));
  return p;
}

let crateSeq = 0;
/** Render the current sample exactly as heard, ready for the crate. */
export async function bounce(name: string, withStems: boolean): Promise<CrateItem | null> {
  if (!S.rendered || !S.source) return null;
  const sr = ctx.sampleRate;
  const bodyLen = S.rendered[0].length;
  const tail = !P.loop && P.reverb > 0 ? 1.5 : 0;
  const full = await applyFx(S.rendered, tail);
  const peak = peakOf(full);
  const safe = peak > 0.99 ? 0.99 / peak : 1;
  if (safe !== 1) for (const c of full) for (let i = 0; i < c.length; i++) c[i] *= safe;
  const slices = [...S.slices];
  const order = [...S.order];
  const flip = isIdentity(order) ? null : buildFlip(full, slices, order, bodyLen, sr).st;

  let stems: CrateItem['stems'] = null;
  if (withStems && S.stems) {
    stems = {};
    for (const s of STEMS) {
      const st = regionMix(s);
      const r = await rpc('render', job(st, S.normGain), [st[0].buffer, st[1].buffer]);
      const fx = await applyFx([r.L, r.R], tail);
      if (peakOf(fx) < 1e-4) continue;
      if (safe !== 1) for (const c of fx) for (let i = 0; i < c.length; i++) c[i] *= safe;
      stems[s] = fx;
    }
  }

  const an = S.analysis;
  const used = S.stems ? STEMS.filter((s) => S.stemOn[s] && S.stemGain[s] > 0).join(', ') : 'full mix';
  const info = [
    `Sample: ${name}`,
    `Source: ${S.source.name}`,
    `Taken from: ${P.start.toFixed(3)} s to ${P.end.toFixed(3)} s`,
    `Length: ${(bodyLen / sr).toFixed(3)} s`,
    an ? `Tempo: ${effBpm().toFixed(1)} BPM (source ${an.bpm} BPM)` : '',
    an?.key ? `Key: ${keyNow()} (source ${an.key})` : '',
    `Pitch shift: ${effSemis().toFixed(2)} semitones`,
    `Speed: ${(P.tempo * 100).toFixed(1)}%${P.linked ? ' (pitch linked to speed)' : ''}`,
    `Reversed: ${P.reverse ? 'yes' : 'no'}`,
    `Stems used: ${used}`,
    `Slices: ${slices.length}`,
    flip ? `Flip order: ${order.map((i) => i + 1).join(' ')}` : '',
    `Filters: high-pass ${Math.round(P.hp)} Hz, low-pass ${Math.round(P.lp)} Hz, drive ${Math.round(P.drive * 100)}%, lo-fi ${Math.round(P.crush * 100)}%, reverb ${Math.round(P.reverb * 100)}%`,
  ]
    .filter(Boolean)
    .join('\r\n');

  return { id: ++crateSeq, name, sr, full, bodyLen, slices, order, flip, stems, info };
}

export function previewItem(item: CrateItem) {
  stop();
  void ctx.resume();
  const buf = ctx.createBuffer(2, item.full[0].length, item.sr);
  buf.getChannelData(0).set(item.full[0]);
  buf.getChannelData(1).set(item.full[1]);
  const n = ctx.createBufferSource();
  n.buffer = buf;
  n.connect(ctx.destination);
  n.start();
}
