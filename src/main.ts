import { crate, exportZip, uniqueName } from './crate';
import { makeDemo } from './demo';
import {
  P,
  S,
  aiStatus,
  beatLen,
  bounce,
  ctx,
  effBpm,
  effSemis,
  emit,
  findLoop,
  fitBars,
  keyNow,
  loadDrums,
  loadFile,
  loadStereo,
  matchTempo,
  on,
  play,
  playSlice,
  playhead,
  previewItem,
  recomputeSlices,
  scheduleRender,
  setLoopLive,
  setRegion,
  splitStems,
  status,
  stop,
  updateFx,
} from './engine';
import { surprise } from './random';
import { DEFAULTS, STEMS, STEM_LABEL } from './state';
import type { Params } from './state';
import { SampleView, SourceView } from './waves';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const clock = (t: number) => {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`;
};
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
const signed = (v: number, unit: string, digits = 0) => `${v > 0 ? '+' : ''}${v.toFixed(digits)} ${unit}`;

const srcView = new SourceView($<HTMLCanvasElement>('srcWave'));
const smpView = new SampleView($<HTMLCanvasElement>('smpWave'));

/* ---------- generic control binding ---------- */
type Kind = 'render' | 'fx' | 'chop' | 'none';
const KIND: Partial<Record<keyof Params, Kind>> = {
  semis: 'render',
  cents: 'render',
  tempo: 'render',
  linked: 'render',
  reverse: 'render',
  crush: 'render',
  fadeIn: 'render',
  fadeOut: 'render',
  normalize: 'render',
  hp: 'fx',
  lp: 'fx',
  res: 'fx',
  drive: 'fx',
  reverb: 'fx',
  gain: 'fx',
  chopMode: 'chop',
  chopCount: 'chop',
};
const pct = (v: number) => `${Math.round(v * 100)}%`;
const FMT: Partial<Record<keyof Params, (v: number) => string>> = {
  semis: (v) => (P.linked ? signed(effSemis(), 'st', 1) : signed(v, 'st')),
  cents: (v) => signed(v, 'ct'),
  tempo: (v) => `${(v * 100).toFixed(1)}%`,
  hp: (v) => (v <= 21 ? 'Off' : hz(v)),
  lp: (v) => (v >= 19800 ? 'Off' : hz(v)),
  res: (v) => `${v.toFixed(1)} dB`,
  drive: pct,
  crush: pct,
  reverb: pct,
  fadeIn: (v) => `${v} ms`,
  fadeOut: (v) => `${v} ms`,
  gain: (v) => signed(v, 'dB', 1),
  chopCount: (v) => String(v),
};

type Ctl = HTMLInputElement | HTMLSelectElement;
const ctls = [...document.querySelectorAll<Ctl>('[data-key]')];

function readEl(el: Ctl): number | boolean | string {
  if (el instanceof HTMLInputElement && el.type === 'checkbox') return el.checked;
  if (el.dataset.key === 'chopMode') return el.value;
  const v = parseFloat(el.value);
  if (el.dataset.log) {
    const [a, b] = el.dataset.log.split(',').map(Number);
    return a * Math.pow(b / a, v / 1000);
  }
  return v * (el.dataset.scale ? parseFloat(el.dataset.scale) : 1);
}

function writeEl(el: Ctl) {
  const key = el.dataset.key as keyof Params;
  const v = P[key];
  if (el instanceof HTMLInputElement && el.type === 'checkbox') {
    el.checked = v as boolean;
    return;
  }
  let shown: string;
  if (typeof v === 'string') shown = v;
  else if (el.dataset.log) {
    const [a, b] = el.dataset.log.split(',').map(Number);
    shown = String(Math.round((1000 * Math.log((v as number) / a)) / Math.log(b / a)));
  } else {
    const raw = (v as number) / (el.dataset.scale ? parseFloat(el.dataset.scale) : 1);
    shown = String(Math.round(raw * 1000) / 1000);
  }
  if (document.activeElement !== el || el.type === 'range') el.value = shown;
  const out = el.parentElement?.querySelector('output');
  const f = FMT[key];
  if (out && f) out.textContent = f(v as number);
}

function apply(key: keyof Params, val: number | boolean | string) {
  if (typeof val === 'number' && !isFinite(val)) return;
  (P as any)[key] = val;
  if (key === 'targetBpm') S.targetTouched = true;
  if (key === 'chopCount' && P.chopMode === 'manual') P.chopMode = 'equal';
  const kind = KIND[key];
  if (kind === 'render') scheduleRender();
  else if (kind === 'fx') updateFx();
  else if (kind === 'chop') recomputeSlices(key === 'chopMode' && val !== 'manual');
  else if (key === 'loop') setLoopLive();
  else if (key === 'targetBpm' && S.playing && S.refMode === 'click') play();
  refresh();
}

for (const el of ctls) {
  const key = el.dataset.key as keyof Params;
  el.addEventListener(el instanceof HTMLSelectElement || el.type === 'checkbox' ? 'change' : 'input', () =>
    apply(key, readEl(el)),
  );
  if (el instanceof HTMLInputElement && el.type === 'range') {
    el.title = 'Double-click to reset';
    el.addEventListener('dblclick', () => apply(key, DEFAULTS[key]));
  }
}

/* ---------- readouts ---------- */
function refresh() {
  ctls.forEach(writeEl);
  const semis = ctls.find((c) => c.dataset.key === 'semis') as HTMLInputElement;
  const cents = ctls.find((c) => c.dataset.key === 'cents') as HTMLInputElement;
  semis.disabled = cents.disabled = P.linked;

  const src = S.source;
  const an = S.analysis;
  if (!src) return;
  $('infoName').textContent = src.name;
  $('infoDur').textContent = clock(src.duration);
  $('infoBpm').textContent = an ? `${an.bpm} BPM` : '';
  $('infoKey').textContent = an?.key ?? '';
  const sb = $<HTMLInputElement>('songBpm');
  if (document.activeElement !== sb) sb.value = an ? String(an.bpm) : '';

  const len = P.end - P.start;
  const T = beatLen();
  const beats = T ? len / T : 0;
  const beatTxt = T ? `   ${Number.isInteger(+beats.toFixed(2)) ? beats.toFixed(0) : beats.toFixed(2)} beats` : '';
  $('regionRead').textContent = `Selection ${clock(P.start)} to ${clock(P.end)}   ${len.toFixed(2)} s${beatTxt}`;

  const r = S.rendered;
  if (r) {
    const parts = [`Sample ${(r[0].length / ctx.sampleRate).toFixed(2)} s`];
    if (an?.bpm) parts.push(`${effBpm().toFixed(1)} BPM`);
    if (an?.key) parts.push(keyNow());
    parts.push(`${S.slices.length} slices`);
    $('sampleRead').textContent = parts.join('   ');
  } else $('sampleRead').textContent = 'Building the sample…';

  $('modeSample').setAttribute('aria-pressed', String(S.playMode === 'sample'));
  $('modeFlip').setAttribute('aria-pressed', String(S.playMode === 'flip'));
  $('btnPlay').textContent = S.playing ? 'Stop' : 'Play';
  $<HTMLSelectElement>('refMode').value = S.refMode;
  $('drumName').textContent = S.drum
    ? `${S.drum.name} at ${S.drum.bpm} BPM`
    : 'Type your drum tempo, tap it, or load the drum loop itself.';

  const nameEl = $<HTMLInputElement>('crateName');
  if (!nameTouched && document.activeElement !== nameEl) nameEl.value = defaultName();
}

let nameTouched = false;
function defaultName(): string {
  if (!S.source) return 'sample';
  const bits = [S.source.name.slice(0, 28)];
  if (S.analysis?.bpm) bits.push(`${Math.round(effBpm())}bpm`);
  const k = keyNow();
  if (k) bits.push(k.replace(' major', 'maj').replace(' minor', 'min').replace('♯', 's').replace('♭', 'b'));
  return uniqueName(bits.join('_'));
}

/* ---------- stems ---------- */
let ai: 'ready' | 'loading' | 'off' = 'off';
async function checkAi() {
  const was = ai;
  ai = await aiStatus();
  if (ai !== was) buildStems();
  if (ai === 'loading') setTimeout(checkAi, 2000);
}
function buildStems() {
  const rows = $('stemRows');
  const aiBtn = $<HTMLButtonElement>('btnSplitAi');
  const quickBtn = $<HTMLButtonElement>('btnSplit');
  aiBtn.hidden = quickBtn.hidden = S.splitting;
  aiBtn.disabled = ai !== 'ready';
  aiBtn.textContent = ai === 'loading' ? 'AI model loading…' : S.stems && S.stemKind === 'ai' ? 'Split with AI again' : 'Split with AI';
  quickBtn.textContent = S.stems && S.stemKind === 'quick' ? 'Quick split again' : 'Quick split';
  $('splitProg').hidden = !S.splitting;
  rows.hidden = !S.stems;
  const mins = S.source ? Math.max(1, Math.round((S.source.duration * 1.2) / 60)) : 1;
  const note = $('stemNote');
  if (S.splitting) {
    note.textContent =
      S.splitKind === 'ai'
        ? `Splitting with Demucs. Expect about ${mins} minute${mins > 1 ? 's' : ''} for this song. You can keep working meanwhile.`
        : 'Splitting. A full song can take up to a minute.';
    return;
  }
  if (!S.stems) {
    note.textContent =
      ai === 'off'
        ? 'Pull the song apart into drums, bass, vocals and everything else. The AI splitter is not running, so only the quick split is available. Start the app with start.bat to get it.'
        : `Pull the song apart into drums, bass, vocals and everything else. AI gives clean stems and takes about ${mins} minute${mins > 1 ? 's' : ''} for this song. Quick is rougher and takes seconds.`;
    return;
  }
  note.textContent =
    S.stemKind === 'ai'
      ? 'AI stems (Demucs). Switch stems off or balance them. The sample is built from what is left on.'
      : S.stemsMono
        ? 'Quick stems. This file is mono, so the vocal stem is empty: the quick split finds vocals by their stereo position. The AI split does not have that limit.'
        : 'Quick stems. Switch stems off or balance them. The sample is built from what is left on.';
  rows.innerHTML = STEMS.map(
    (s) => `<div class="stem ${S.stemOn[s] ? '' : 'off'}" style="--c:var(--stem-${s})">
      <button data-stem="${s}" aria-pressed="${S.stemOn[s]}" aria-label="${STEM_LABEL[s]} on or off"></button>
      <span>${STEM_LABEL[s]}</span>
      <input type="range" data-stemgain="${s}" min="0" max="150" value="${Math.round(S.stemGain[s] * 100)}" aria-label="${STEM_LABEL[s]} level" />
    </div>`,
  ).join('');
}
$('stemRows').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-stem]');
  if (!b) return;
  const s = b.dataset.stem as (typeof STEMS)[number];
  S.stemOn[s] = !S.stemOn[s];
  buildStems();
  scheduleRender();
});
$('stemRows').addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  const s = el.dataset.stemgain as (typeof STEMS)[number] | undefined;
  if (!s) return;
  S.stemGain[s] = +el.value / 100;
  scheduleRender();
});
$('btnSplit').onclick = () => splitStems('quick').catch((e) => status(String(e)));
$('btnSplitAi').onclick = () =>
  splitStems('ai').catch((e) => {
    status(`AI split failed: ${e.message ?? e}`);
    void checkAi();
  });
on('stemProgress', (p: number) => ($<HTMLProgressElement>('splitProg').value = p));
on('stems', buildStems);

/* ---------- pads and flip order ---------- */
const KEYS = '1234567890qwertyuiopasdfghjklzxcvbnm';
let lastPad = -1;
function buildPads() {
  lastPad = -1;
  $('pads').innerHTML = S.slices
    .map((_, i) => `<button class="pad" data-i="${i}">${i + 1}<small>${KEYS[i]?.toUpperCase() ?? ''}</small></button>`)
    .join('');
  $('order').innerHTML = S.order
    .map((s, pos) => `<span class="chip ${s !== pos ? 'moved' : ''}" draggable="true" data-pos="${pos}">${s + 1}</span>`)
    .join('');
}
$('pads').addEventListener('pointerdown', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.pad');
  if (b) playSlice(+b.dataset.i!);
});
let dragPos = -1;
const orderEl = $('order');
orderEl.addEventListener('dragstart', (e) => {
  dragPos = +((e.target as HTMLElement).dataset.pos ?? -1);
  e.dataTransfer?.setData('text/plain', String(dragPos));
});
orderEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  orderEl.querySelectorAll('.over').forEach((c) => c.classList.remove('over'));
  (e.target as HTMLElement).closest('.chip')?.classList.add('over');
});
orderEl.addEventListener('drop', (e) => {
  e.preventDefault();
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.chip');
  if (!chip || dragPos < 0) return;
  const to = +chip.dataset.pos!;
  const [m] = S.order.splice(dragPos, 1);
  S.order.splice(to, 0, m);
  dragPos = -1;
  orderChanged();
});
orderEl.addEventListener('click', (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.chip');
  if (chip) playSlice(S.order[+chip.dataset.pos!]);
});
function orderChanged() {
  buildPads();
  refresh();
  if (S.playing && S.playMode === 'flip') play('flip');
}
$('btnShuffle').onclick = () => {
  for (let i = S.order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [S.order[i], S.order[j]] = [S.order[j], S.order[i]];
  }
  orderChanged();
  play('flip');
};
$('btnRevOrder').onclick = () => {
  S.order.reverse();
  orderChanged();
};
$('btnResetOrder').onclick = () => {
  S.order = S.slices.map((_, i) => i);
  orderChanged();
};

/* ---------- transport ---------- */
const toggle = () => (S.playing ? stop() : play());
$('btnPlay').onclick = toggle;
$('modeSample').onclick = () => {
  S.playMode = 'sample';
  S.playing ? play('sample') : refresh();
};
$('modeFlip').onclick = () => {
  S.playMode = 'flip';
  S.playing ? play('flip') : refresh();
};
$('btnSurprise').onclick = () => surprise().catch((e) => status(String(e)));

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t instanceof HTMLSelectElement) return;
  if (t instanceof HTMLInputElement && t.type !== 'range' && t.type !== 'checkbox') return;
  if (e.ctrlKey || e.metaKey || e.altKey || !S.rendered) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (t instanceof HTMLButtonElement) t.blur();
    toggle();
    return;
  }
  if (e.repeat) return;
  const i = KEYS.indexOf(e.key.toLowerCase());
  if (i >= 0 && i < S.slices.length) playSlice(i);
});

/* ---------- pitch / filters reset ---------- */
$('btnPitchReset').onclick = () => {
  Object.assign(P, { semis: 0, cents: 0, tempo: 1, linked: false, reverse: false });
  scheduleRender();
  refresh();
};
$('btnFxReset').onclick = () => {
  const d = DEFAULTS;
  Object.assign(P, {
    hp: d.hp,
    lp: d.lp,
    res: d.res,
    drive: d.drive,
    crush: d.crush,
    reverb: d.reverb,
    gain: d.gain,
    fadeIn: d.fadeIn,
    fadeOut: d.fadeOut,
  });
  updateFx();
  scheduleRender();
  refresh();
};

/* ---------- beat match ---------- */
function setSongBpm(v: number) {
  if (!S.analysis || !isFinite(v) || v < 30 || v > 300) return;
  S.analysis.bpm = Math.round(v * 10) / 10;
  srcView.invalidate();
  if (P.chopMode === 'beat') recomputeSlices();
  refresh();
}
$<HTMLInputElement>('songBpm').addEventListener('change', (e) => setSongBpm(+(e.target as HTMLInputElement).value));
$('bpmHalf').onclick = () => S.analysis && setSongBpm(S.analysis.bpm / 2);
$('bpmDouble').onclick = () => S.analysis && setSongBpm(S.analysis.bpm * 2);

let taps: number[] = [];
$('btnTap').onclick = () => {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
  taps.push(now);
  taps = taps.slice(-7);
  if (taps.length >= 3) {
    const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    apply('targetBpm', Math.round(600000 / avg) / 10);
  }
};
$('btnDrum').onclick = () => $('drumInput').click();
$<HTMLInputElement>('drumInput').onchange = (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void loadDrums(f);
  (e.target as HTMLInputElement).value = '';
};
on('drum', refresh);
$('btnMatch').onclick = () => {
  P.linked = false;
  if (!matchTempo()) status('Set the song tempo and your drum tempo first.');
  else status('');
  refresh();
};
$('btnFit').onclick = () => {
  P.linked = false;
  if (!fitBars())
    status(`That selection is too far from ${P.bars} bar${P.bars > 1 ? 's' : ''} at ${P.targetBpm} BPM. Change the selection or the bar count.`);
  else status('');
  refresh();
};
$<HTMLSelectElement>('refMode').onchange = (e) => {
  const v = (e.target as HTMLSelectElement).value as typeof S.refMode;
  if (v === 'drums' && !S.drum) {
    status('Load a drum loop first.');
    refresh();
    return;
  }
  S.refMode = v;
  if (S.playing) play();
};

/* ---------- loop finder ---------- */
const noLoop = () => status('No steady beat found here. Drag a selection by hand.');
$('btnFindLoop').onclick = () => (findLoop('near') ? status('') : noLoop());
$('btnOtherLoop').onclick = () => (findLoop('any') ? status('') : noLoop());
$('btnPrev').onclick = () => {
  const T = beatLen() || 0.25;
  setRegion(P.start - T, P.end - T);
};
$('btnNext').onclick = () => {
  const T = beatLen() || 0.25;
  setRegion(P.start + T, P.end + T);
};
$('btnHalf').onclick = () => setRegion(P.start, P.start + (P.end - P.start) / 2);
$('btnDouble').onclick = () => setRegion(P.start, P.start + (P.end - P.start) * 2);
$('btnZoomSel').onclick = () => srcView.zoomSel();
$('btnZoomAll').onclick = () => srcView.zoomAll();

/* ---------- crate ---------- */
$<HTMLInputElement>('crateName').addEventListener('input', () => (nameTouched = true));
function buildCrate() {
  $('crateList').innerHTML = crate
    .map((c) => {
      const extras = [`${(c.bodyLen / c.sr).toFixed(2)} s`, `${c.slices.length} slices`];
      if (c.flip) extras.push('flip');
      if (c.stems) extras.push(`${Object.keys(c.stems).length} stems`);
      return `<li><span class="nm">${esc(c.name)}</span><span class="meta">${extras.join(', ')}</span>
        <button class="btn small" data-act="play" data-id="${c.id}">Play</button>
        <button class="btn small" data-act="del" data-id="${c.id}">Remove</button></li>`;
    })
    .join('');
  $('crateEmpty').hidden = crate.length > 0;
  $<HTMLButtonElement>('btnZip').disabled = crate.length === 0;
  $('btnZip').textContent = crate.length ? `Export ${crate.length} sample${crate.length > 1 ? 's' : ''} as ZIP` : 'Export crate as ZIP';
}
$('btnAdd').onclick = async () => {
  const btn = $<HTMLButtonElement>('btnAdd');
  btn.disabled = true;
  try {
    const name = uniqueName($<HTMLInputElement>('crateName').value || defaultName());
    const item = await bounce(name, $<HTMLInputElement>('crateStems').checked);
    if (item) {
      crate.push(item);
      nameTouched = false;
      buildCrate();
      refresh();
      status(`Added ${name} to the crate.`);
    }
  } catch (e) {
    status(String(e));
  } finally {
    btn.disabled = false;
  }
};
$('crateList').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!b) return;
  const i = crate.findIndex((c) => c.id === +b.dataset.id!);
  if (i < 0) return;
  if (b.dataset.act === 'play') previewItem(crate[i]);
  else {
    crate.splice(i, 1);
    buildCrate();
    refresh();
  }
});
$('btnZip').onclick = () => {
  const bits = +$<HTMLSelectElement>('bitDepth').value as 16 | 24;
  const blob = exportZip(bits);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'flipside_crate.zip';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  status(`Exported ${crate.length} sample${crate.length > 1 ? 's' : ''} to flipside_crate.zip.`);
};

/* ---------- loading ---------- */
const fileInput = $<HTMLInputElement>('fileInput');
$('btnOpen').onclick = $('btnPick').onclick = () => fileInput.click();
fileInput.onchange = () => {
  const f = fileInput.files?.[0];
  if (f) void loadFile(f);
  fileInput.value = '';
};
$('btnDemo').onclick = () => void loadStereo('demo_groove', makeDemo(ctx.sampleRate));
const drop = $('drop');
window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  drop.classList.add('over');
});
window.addEventListener('dragleave', () => drop.classList.remove('over'));
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  drop.classList.remove('over');
  void loadFile(e.dataTransfer.files[0]);
});

/* ---------- events and drawing ---------- */
let needDraw = true;
on('draw', () => (needDraw = true));
on('status', (m: string) => ($('status').textContent = m));
on('source', () => {
  void checkAi();
  $('empty').hidden = true;
  $('bench').hidden = false;
  nameTouched = false;
  srcView.setSource();
  smpView.invalidate();
  buildStems();
  buildPads();
  refresh();
});
on('analysis', () => {
  srcView.zoomSel();
  refresh();
});
on('region', () => {
  needDraw = true;
  refresh();
});
on('rendered', () => {
  smpView.invalidate();
  refresh();
});
on('slices', () => {
  buildPads();
  needDraw = true;
  refresh();
});
on('params', () => {
  updateFx();
  refresh();
});
on('play', () => {
  needDraw = true;
  refresh();
});

function frame() {
  if (S.playing || needDraw) {
    needDraw = false;
    const head = playhead();
    srcView.draw(head);
    smpView.draw(head);
    let idx = -1;
    if (head >= 0) {
      const pos = head * ctx.sampleRate;
      for (let i = 0; i < S.slices.length; i++) if (S.slices[i] <= pos) idx = i;
    }
    if (idx !== lastPad) {
      const pads = $('pads').children;
      pads[lastPad]?.classList.remove('on');
      pads[idx]?.classList.add('on');
      lastPad = idx;
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
refresh();
buildCrate();
void checkAi();
void emit;
