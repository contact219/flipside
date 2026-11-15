import { P, S, ctx, emit, playSlice, recomputeSlices, setRegion, snapTime } from './engine';

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function fit(c: HTMLCanvasElement): boolean {
  const r = c.getBoundingClientRect();
  const d = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * d));
  const h = Math.max(1, Math.round(r.height * d));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
    return true;
  }
  return false;
}

/** Draw min/max columns for samples [a, b) spread over the canvas width. */
function drawColumns(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  range: (x: number) => [number, number],
) {
  const mid = h / 2;
  const amp = h * 0.46;
  g.beginPath();
  for (let x = 0; x < w; x++) {
    const [lo, hi] = range(x);
    const y0 = mid - hi * amp;
    const y1 = mid - lo * amp;
    g.rect(x, y0, 1, Math.max(1, y1 - y0));
  }
  g.fill();
}

/* ================= song view ================= */
export class SourceView {
  private g: CanvasRenderingContext2D;
  private stat = document.createElement('canvas');
  private pmin = new Float32Array(0);
  private pmax = new Float32Array(0);
  vs = 0;
  ve = 1;
  private drag: null | { kind: 'l' | 'r' | 'move' | 'new'; anchor: number; a0: number; b0: number } = null;
  /** fingers on the canvas, by pointer id, as canvas x positions */
  private pts = new Map<number, number>();
  /** two-finger zoom and slide: the finger spacing, view width and time under the fingers when it began */
  private pinch: null | { d0: number; span0: number; tMid: number } = null;
  private dirty = true;

  constructor(private c: HTMLCanvasElement) {
    this.g = c.getContext('2d')!;
    new ResizeObserver(() => this.invalidate()).observe(c);
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', (e) => this.up(e));
    c.addEventListener('pointercancel', (e) => this.up(e));
    c.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    c.addEventListener('dblclick', () => this.zoomSel());
  }

  setSource() {
    const src = S.source;
    if (!src) return;
    const [L, R] = src.ch;
    const n = Math.ceil(L.length / 256);
    this.pmin = new Float32Array(n);
    this.pmax = new Float32Array(n);
    for (let b = 0; b < n; b++) {
      let lo = 1;
      let hi = -1;
      const end = Math.min(L.length, (b + 1) * 256);
      for (let i = b * 256; i < end; i++) {
        const v = 0.5 * (L[i] + R[i]);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      this.pmin[b] = lo;
      this.pmax[b] = hi;
    }
    this.zoomAll();
  }

  invalidate() {
    this.dirty = true;
    emit('draw');
  }
  zoomAll() {
    this.vs = 0;
    this.ve = S.source?.duration ?? 1;
    this.invalidate();
  }
  zoomSel() {
    const pad = (P.end - P.start) * 0.6;
    this.setView(P.start - pad, P.end + pad);
  }
  private setView(a: number, b: number) {
    const d = S.source?.duration ?? 1;
    const span = Math.min(d, Math.max(0.05, b - a));
    a = Math.max(0, Math.min(d - span, a));
    this.vs = a;
    this.ve = a + span;
    this.invalidate();
  }

  private t2x(t: number) {
    return ((t - this.vs) / (this.ve - this.vs)) * this.c.width;
  }
  private x2t(x: number) {
    return this.vs + (x / this.c.width) * (this.ve - this.vs);
  }
  private px(e: PointerEvent | WheelEvent) {
    const r = this.c.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * this.c.width;
  }

  private hit(x: number, shift: boolean, touch = false): 'l' | 'r' | 'move' | 'new' {
    // a fingertip needs a wider grab zone than a mouse pointer
    const d = (window.devicePixelRatio || 1) * (touch ? 20 : 7);
    const xs = this.t2x(P.start);
    const xe = this.t2x(P.end);
    if (shift) return 'new';
    const ds = Math.abs(x - xs);
    const de = Math.abs(x - xe);
    if (ds < d || de < d) return ds <= de ? 'l' : 'r';
    if (x > xs && x < xe) return 'move';
    return 'new';
  }

  private down(e: PointerEvent) {
    if (!S.source) return;
    this.c.setPointerCapture(e.pointerId);
    const x = this.px(e);
    this.pts.set(e.pointerId, x);
    if (this.pts.size === 2) {
      // a second finger means zoom, so undo whatever the first finger had started to do
      if (this.drag) setRegion(this.drag.a0, this.drag.b0);
      this.drag = null;
      const [x1, x2] = [...this.pts.values()];
      this.pinch = { d0: Math.max(1, Math.abs(x1 - x2)), span0: this.ve - this.vs, tMid: this.x2t((x1 + x2) / 2) };
      return;
    }
    if (this.pts.size > 2) return;
    const kind = this.hit(x, e.shiftKey, e.pointerType === 'touch');
    this.drag = { kind, anchor: this.x2t(x), a0: P.start, b0: P.end };
  }

  private up(e: PointerEvent) {
    this.pts.delete(e.pointerId);
    this.drag = null;
    if (this.pts.size < 2) this.pinch = null;
  }

  private move(e: PointerEvent) {
    if (!S.source) return;
    const x = this.px(e);
    if (this.pts.has(e.pointerId)) this.pts.set(e.pointerId, x);
    if (this.pinch && this.pts.size >= 2) {
      const [x1, x2] = [...this.pts.values()];
      const span = (this.pinch.span0 * this.pinch.d0) / Math.max(1, Math.abs(x1 - x2));
      const a = this.pinch.tMid - ((x1 + x2) / 2 / this.c.width) * span;
      this.setView(a, a + span);
      return;
    }
    if (!this.drag) {
      const k = this.hit(x, e.shiftKey);
      this.c.style.cursor = k === 'l' || k === 'r' ? 'ew-resize' : k === 'move' ? 'grab' : 'crosshair';
      return;
    }
    const t = Math.max(0, Math.min(S.source.duration, this.x2t(x)));
    const d = this.drag;
    if (d.kind === 'l') {
      const a = Math.min(snapTime(t), P.end - 0.02);
      P.start = Math.max(0, a);
      setRegion(P.start, P.end);
    } else if (d.kind === 'r') {
      const b = Math.max(snapTime(t), P.start + 0.02);
      setRegion(P.start, Math.min(S.source.duration, b));
    } else if (d.kind === 'move') {
      const a = snapTime(d.a0 + (t - d.anchor));
      setRegion(a, a + (d.b0 - d.a0));
    } else {
      const a = snapTime(Math.min(d.anchor, t));
      const b = snapTime(Math.max(d.anchor, t));
      if (b - a >= 0.02) setRegion(a, b);
    }
  }

  private wheel(e: WheelEvent) {
    if (!S.source) return;
    e.preventDefault();
    const span = this.ve - this.vs;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const dx = ((e.deltaX || e.deltaY) / 600) * span;
      this.setView(this.vs + dx, this.ve + dx);
      return;
    }
    const t = this.x2t(this.px(e));
    const k = Math.exp(e.deltaY * 0.0015);
    this.setView(t - (t - this.vs) * k, t + (this.ve - t) * k);
  }

  private drawStatic() {
    const { width: w, height: h } = this.c;
    this.stat.width = w;
    this.stat.height = h;
    const g = this.stat.getContext('2d')!;
    g.fillStyle = css('--lcd');
    g.fillRect(0, 0, w, h);
    const src = S.source;
    if (!src) return;
    const sr = ctx.sampleRate;
    const an = S.analysis;
    if (an && an.bpm > 0) {
      const T = 60 / an.bpm;
      const pxBeat = (T / (this.ve - this.vs)) * w;
      const every = pxBeat > 6 ? 1 : pxBeat * 4 > 6 ? 4 : 0;
      if (every) {
        const k0 = Math.ceil((this.vs - an.barOffset) / T);
        for (let k = k0; ; k++) {
          const t = an.barOffset + k * T;
          if (t > this.ve) break;
          const bar = ((k % 4) + 4) % 4 === 0;
          if (every === 4 && !bar) continue;
          g.fillStyle = bar ? 'rgba(185,235,208,0.28)' : 'rgba(185,235,208,0.1)';
          g.fillRect(Math.round(this.t2x(t)), 0, 1, h);
        }
      }
    }
    g.fillStyle = css('--lcd-wave');
    const spp = ((this.ve - this.vs) * sr) / w;
    const [L, R] = src.ch;
    drawColumns(g, w, h, (x) => {
      const a = Math.floor((this.vs + (x / w) * (this.ve - this.vs)) * sr);
      const b = Math.max(a + 1, Math.floor(a + spp));
      let lo = 1;
      let hi = -1;
      if (spp >= 512) {
        const e = Math.min(this.pmin.length, Math.ceil(b / 256));
        for (let i = Math.floor(a / 256); i < e; i++) {
          if (this.pmin[i] < lo) lo = this.pmin[i];
          if (this.pmax[i] > hi) hi = this.pmax[i];
        }
      } else {
        const e = Math.min(L.length, b);
        for (let i = Math.max(0, a); i < e; i++) {
          const v = 0.5 * (L[i] + R[i]);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      return lo > hi ? [0, 0] : [lo, hi];
    });
  }

  draw(head: number) {
    if (fit(this.c)) this.dirty = true;
    if (this.dirty) {
      this.drawStatic();
      this.dirty = false;
    }
    const g = this.g;
    const { width: w, height: h } = this.c;
    g.drawImage(this.stat, 0, 0);
    if (!S.source) return;
    const xs = this.t2x(P.start);
    const xe = this.t2x(P.end);
    g.fillStyle = 'rgba(8,24,22,0.62)';
    g.fillRect(0, 0, Math.max(0, xs), h);
    g.fillRect(xe, 0, Math.max(0, w - xe), h);
    g.fillStyle = css('--hot');
    const d = window.devicePixelRatio || 1;
    g.fillRect(xs - d, 0, 2 * d, h);
    g.fillRect(xe - d, 0, 2 * d, h);
    g.fillRect(xs, 0, xe - xs, 2 * d);
    if (head >= 0 && S.rendered) {
      let f = head / (S.rendered[0].length / ctx.sampleRate);
      if (P.reverse) f = 1 - f;
      const x = this.t2x(P.start + f * (P.end - P.start));
      g.fillStyle = '#fff';
      g.fillRect(x, 0, d, h);
    }
  }
}

/* ================= sample view ================= */
export class SampleView {
  private g: CanvasRenderingContext2D;
  private stat = document.createElement('canvas');
  private dirty = true;
  private dragMarker = -1;

  constructor(private c: HTMLCanvasElement) {
    this.g = c.getContext('2d')!;
    new ResizeObserver(() => this.invalidate()).observe(c);
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', () => (this.dragMarker = -1));
    c.addEventListener('pointercancel', () => (this.dragMarker = -1));
  }
  invalidate() {
    this.dirty = true;
    emit('draw');
  }
  private n() {
    return S.rendered ? S.rendered[0].length : 1;
  }
  private px(e: PointerEvent) {
    const r = this.c.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * this.c.width;
  }
  private markerAt(x: number, touch = false): number {
    const w = this.c.width;
    // wider grab zone for fingers, but never more than a third of a slice so the slices stay tappable
    let d = (window.devicePixelRatio || 1) * (touch ? 16 : 6);
    if (touch) d = Math.max((window.devicePixelRatio || 1) * 6, Math.min(d, w / S.slices.length / 3));
    let best = -1;
    let bestD = d;
    for (let i = 1; i < S.slices.length; i++) {
      const dist = Math.abs((S.slices[i] / this.n()) * w - x);
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    }
    return best;
  }
  private down(e: PointerEvent) {
    if (!S.rendered) return;
    const x = this.px(e);
    const m = this.markerAt(x, e.pointerType === 'touch');
    if (m > 0) {
      this.dragMarker = m;
      this.c.setPointerCapture(e.pointerId);
      return;
    }
    const pos = (x / this.c.width) * this.n();
    let idx = 0;
    for (let i = 0; i < S.slices.length; i++) if (S.slices[i] <= pos) idx = i;
    playSlice(idx);
  }
  private move(e: PointerEvent) {
    const x = this.px(e);
    if (this.dragMarker < 0) {
      this.c.style.cursor = this.markerAt(x) > 0 ? 'ew-resize' : 'pointer';
      return;
    }
    const i = this.dragMarker;
    const n = this.n();
    const min = S.slices[i - 1] + 64;
    const max = (i + 1 < S.slices.length ? S.slices[i + 1] : n) - 64;
    S.slices[i] = Math.round(Math.max(min, Math.min(max, (x / this.c.width) * n)));
    if (P.chopMode !== 'manual') {
      P.chopMode = 'manual';
      emit('params');
    }
    emit('draw');
  }

  private drawStatic() {
    const { width: w, height: h } = this.c;
    this.stat.width = w;
    this.stat.height = h;
    const g = this.stat.getContext('2d')!;
    g.fillStyle = css('--lcd');
    g.fillRect(0, 0, w, h);
    const r = S.rendered;
    if (!r) return;
    const n = r[0].length;
    const spp = n / w;
    g.fillStyle = css('--lcd-wave');
    drawColumns(g, w, h, (x) => {
      const a = Math.floor(x * spp);
      const b = Math.min(n, Math.max(a + 1, Math.floor((x + 1) * spp)));
      const step = Math.max(1, Math.floor((b - a) / 200));
      let lo = 1;
      let hi = -1;
      for (let i = a; i < b; i += step) {
        const v = 0.5 * (r[0][i] + r[1][i]);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      return lo > hi ? [0, 0] : [lo, hi];
    });
  }

  draw(head: number) {
    if (fit(this.c)) this.dirty = true;
    if (this.dirty) {
      this.drawStatic();
      this.dirty = false;
    }
    const g = this.g;
    const { width: w, height: h } = this.c;
    g.drawImage(this.stat, 0, 0);
    if (!S.rendered) return;
    const n = this.n();
    const d = window.devicePixelRatio || 1;
    const sr = ctx.sampleRate;
    if (head >= 0) {
      const pos = head * sr;
      let idx = 0;
      for (let i = 0; i < S.slices.length; i++) if (S.slices[i] <= pos) idx = i;
      const a = (S.slices[idx] / n) * w;
      const b = ((idx + 1 < S.slices.length ? S.slices[idx + 1] : n) / n) * w;
      g.fillStyle = 'rgba(43,80,200,0.35)';
      g.fillRect(a, 0, b - a, h);
    }
    g.font = `${11 * d}px 'DM Mono', monospace`;
    g.textBaseline = 'top';
    const showNum = w / S.slices.length > 16 * d;
    for (let i = 0; i < S.slices.length; i++) {
      const x = Math.round((S.slices[i] / n) * w);
      if (i > 0) {
        g.fillStyle = '#8fa8ff';
        g.fillRect(x, 0, d, h);
        g.fillRect(x - 3 * d, 0, 7 * d, 4 * d);
      }
      if (showNum) {
        g.fillStyle = '#dfe6ff';
        g.fillText(String(i + 1), x + 4 * d, 6 * d);
      }
    }
    if (head >= 0) {
      g.fillStyle = '#fff';
      g.fillRect((head * sr * w) / n, 0, d, h);
    }
  }
}

export function commitManualSlices() {
  recomputeSlices();
}
