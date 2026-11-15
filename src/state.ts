export const STEMS = ['drums', 'bass', 'vocals', 'other'] as const;
export type StemName = (typeof STEMS)[number];
export const STEM_LABEL: Record<StemName, string> = {
  drums: 'Drums',
  bass: 'Bass',
  vocals: 'Vocals / lead',
  other: 'Everything else',
};
export type Stereo = [Float32Array, Float32Array];

export interface Params {
  start: number; // selection in the song, seconds
  end: number;
  semis: number;
  cents: number;
  tempo: number; // 1 = original speed
  linked: boolean; // pitch follows speed, like a turntable
  reverse: boolean;
  hp: number;
  lp: number;
  res: number;
  drive: number;
  crush: number;
  reverb: number;
  gain: number; // dB
  fadeIn: number; // ms
  fadeOut: number;
  normalize: boolean;
  loop: boolean;
  chopMode: 'equal' | 'transient' | 'beat' | 'manual';
  chopCount: number;
  targetBpm: number;
  bars: number;
  snap: boolean;
}

export const DEFAULTS: Params = {
  start: 0,
  end: 1,
  semis: 0,
  cents: 0,
  tempo: 1,
  linked: false,
  reverse: false,
  hp: 20,
  lp: 20000,
  res: 0,
  drive: 0,
  crush: 0,
  reverb: 0,
  gain: 0,
  fadeIn: 0,
  fadeOut: 0,
  normalize: true,
  loop: true,
  chopMode: 'equal',
  chopCount: 8,
  targetBpm: 90,
  bars: 4,
  snap: true,
};

export interface Analysis {
  bpm: number;
  key: string;
  beatOffset: number; // time of one beat, seconds
  barOffset: number; // time of one likely bar line, seconds
  env: Float32Array; // onset strength
  rate: number; // env frames per second
  offset: number; // time of env frame 0
}

export interface CrateItem {
  id: number;
  name: string;
  sr: number;
  full: Stereo;
  bodyLen: number; // length without any reverb tail
  slices: number[];
  order: number[];
  flip: Stereo | null;
  stems: Partial<Record<StemName, Stereo>> | null;
  info: string;
}
