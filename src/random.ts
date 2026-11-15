import { P, S, emit, findLoop, matchTempo, play, regionMix, renderNow, splitStems, status, updateFx } from './engine';
import { STEMS } from './state';
import type { StemName } from './state';

const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const chance = (p: number) => Math.random() < p;
const between = (a: number, b: number) => a + Math.random() * (b - a);

const COMBOS: StemName[][] = [
  ['bass', 'vocals', 'other'],
  ['bass', 'vocals', 'other'],
  ['vocals', 'other'],
  ['vocals', 'other'],
  ['other'],
  ['other'],
  ['bass', 'other'],
  ['vocals'],
  ['drums', 'other'],
  ['drums', 'bass', 'vocals', 'other'],
];

function loudEnough(): boolean {
  const [L] = regionMix();
  let s = 0;
  for (let i = 0; i < L.length; i += 8) s += L[i] * L[i];
  return Math.sqrt((s * 8) / Math.max(1, L.length)) > 0.012;
}

/** Roll a whole sample: where it comes from, which stems, pitch, speed, chops, order and filters. */
export async function surprise() {
  if (!S.source || !S.analysis) return;
  if (!S.stems) {
    status('Splitting stems first, so the dice have something to work with…');
    await splitStems();
    status('');
  }

  P.bars = pick([1, 2, 2, 4, 4]);
  for (let attempt = 0; attempt < 8; attempt++) {
    findLoop('any', P.bars);
    let combo = pick(COMBOS);
    if (S.stemsMono) combo = combo.filter((s) => s !== 'vocals');
    if (!combo.length) combo = ['other'];
    for (const s of STEMS) {
      S.stemOn[s] = combo.includes(s);
      S.stemGain[s] = 1;
    }
    if (loudEnough()) break;
    if (attempt === 7) for (const s of STEMS) S.stemOn[s] = true;
  }

  P.cents = 0;
  P.reverse = chance(0.08);
  P.linked = chance(0.3);
  const matching = S.targetTouched || !!S.drum;
  if (P.linked) {
    // turntable style: slow it down and let the pitch drop, or the opposite
    P.semis = 0;
    P.tempo = pick([0.75, 0.8, 0.84, 0.89, 0.94, 1.06, 1.12, 1.19]);
  } else {
    P.semis = pick([-7, -5, -4, -3, -2, -2, -1, 0, 0, 1, 2, 3, 4, 5]);
    P.tempo = 1;
    if (matching) matchTempo();
    else P.tempo = pick([0.85, 0.9, 0.95, 1, 1, 1.05, 1.1]);
  }

  P.hp = chance(0.25) ? between(120, 450) : 20;
  P.lp = chance(0.35) ? between(1800, 9000) : 20000;
  P.res = P.lp < 20000 && chance(0.4) ? between(2, 9) : 0;
  P.drive = chance(0.3) ? between(0.08, 0.35) : 0;
  P.crush = chance(0.2) ? between(0.15, 0.45) : 0;
  P.reverb = chance(0.2) ? between(0.08, 0.25) : 0;
  P.gain = 0;
  P.fadeIn = 0;
  P.fadeOut = 0;

  P.chopMode = pick(['equal', 'equal', 'transient']);
  P.chopCount = pick([4, 8, 8, 16]);

  updateFx();
  await renderNow();

  const shuffled = chance(0.5);
  if (shuffled) {
    // keep the first slice in place so the flip still lands on the one
    const rest = S.order.slice(1);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    S.order = [0, ...rest];
    emit('slices');
  }
  emit('stems');
  emit('params');
  play(shuffled ? 'flip' : 'sample');
}
