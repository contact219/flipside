import type { Stereo } from './state';

/** A small synthesized groove so the app can be tried without a file. 94 BPM, A minor, 8 bars. */
export function makeDemo(sr: number): Stereo {
  const bpm = 94;
  const beat = 60 / bpm;
  const bars = 8;
  const len = Math.round(bars * 4 * beat * sr);
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

  const voice = (t0: number, dur: number, panL: number, panR: number, fn: (t: number) => number) => {
    const a = Math.round(t0 * sr);
    const n = Math.round(dur * sr);
    for (let i = 0; i < n && a + i < len; i++) {
      const s = fn(i / sr);
      L[a + i] += s * panL;
      R[a + i] += s * panR;
    }
  };

  const chords = [
    { bass: 45, notes: [57, 60, 64, 67] },
    { bass: 41, notes: [57, 60, 64, 65] },
    { bass: 48, notes: [55, 59, 64, 67] },
    { bass: 43, notes: [59, 62, 64, 67] },
  ];
  const melody = [69, 72, 76, 74, 72, 69, 67, 69, 72, 74, 76, 79, 76, 74, 72, 69];

  for (let bar = 0; bar < bars; bar++) {
    const t = bar * 4 * beat;
    const ch = chords[(bar >> 1) % 4];

    for (const b of [0, 1.75, 2.5]) {
      voice(t + b * beat, 0.35, 1, 1, (x) => {
        const f = 45 + 110 * Math.exp(-x * 28);
        return Math.sin(2 * Math.PI * f * x + 1.2 * Math.exp(-x * 28)) * Math.exp(-x * 7) * 0.8;
      });
    }
    for (const b of [1, 3]) {
      voice(t + b * beat, 0.25, 1, 1, (x) => {
        return (
          (Math.random() * 2 - 1) * Math.exp(-x * 18) * 0.4 +
          Math.sin(2 * Math.PI * 190 * x) * Math.exp(-x * 22) * 0.35
        );
      });
    }
    for (let h = 0; h < 8; h++) {
      const swing = h % 2 ? 0.06 * beat : 0;
      let prev = 0;
      voice(t + h * 0.5 * beat + swing, 0.06, h % 2 ? 0.5 : 1, h % 2 ? 1 : 0.5, (x) => {
        const n = Math.random() * 2 - 1;
        const s = n - prev;
        prev = n;
        return s * Math.exp(-x * 70) * 0.14;
      });
    }
    for (const b of [0, 0.75, 1.5, 2.5, 3.5]) {
      const f = hz(ch.bass - 12);
      voice(t + b * beat, 0.3, 1, 1, (x) => {
        const env = Math.min(1, x * 200) * Math.exp(-x * 5);
        return (Math.sin(2 * Math.PI * f * x) + 0.35 * Math.sin(4 * Math.PI * f * x)) * env * 0.3;
      });
    }
    for (const b of [0, 2.5]) {
      ch.notes.forEach((note, i) => {
        const f = hz(note);
        voice(t + b * beat, 1.4, i % 2 ? 0.2 : 0.95, i % 2 ? 0.95 : 0.2, (x) => {
          const env = Math.min(1, x * 100) * Math.exp(-x * 1.6) * (1 + 0.15 * Math.sin(2 * Math.PI * 5 * x));
          return (
            (Math.sin(2 * Math.PI * f * x) +
              0.3 * Math.sin(4 * Math.PI * f * x) +
              0.1 * Math.sin(6 * Math.PI * f * x)) *
            env *
            0.085
          );
        });
      });
    }
    if (bar % 2 === 0) {
      for (let m = 0; m < 4; m++) {
        const f = hz(melody[((bar >> 1) * 4 + m) % melody.length]);
        voice(t + (m * 1.5 + 0.5) * beat, 0.55, 1, 1, (x) => {
          const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * x);
          const ph = 2 * Math.PI * f * vib * x;
          const env = Math.min(1, x * 60) * Math.exp(-x * 3);
          return (Math.sin(ph) + 0.25 * Math.sin(3 * ph) + 0.1 * Math.sin(5 * ph)) * env * 0.13;
        });
      }
    }
  }
  return [L, R];
}
