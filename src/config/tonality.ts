import type { LineSoundConfig, ResolvedLineSoundConfig, TonalityConfig } from './types'

const ROOT_TO_SEMITONE: Record<string, number> = {
  C: 0,
  Db: 1,
  D: 2,
  Eb: 3,
  E: 4,
  F: 5,
  Gb: 6,
  G: 7,
  Ab: 8,
  A: 9,
  Bb: 10,
  B: 11,
}

const SEMITONE_TO_NOTE = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']

const MODE_INTERVALS: Record<TonalityConfig['mode'], number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
}

export function resolveLineSoundConfig(
  lineConfig: LineSoundConfig,
  tonality: TonalityConfig,
): ResolvedLineSoundConfig {
  const rootSemitone = ROOT_TO_SEMITONE[tonality.root] ?? ROOT_TO_SEMITONE.C
  const intervals = MODE_INTERVALS[tonality.mode]
  const degree = lineConfig.degrees[Math.floor(Math.random() * lineConfig.degrees.length)]
  const degreeIndex = Math.max(0, Math.min(intervals.length - 1, degree - 1))
  const semitone = (rootSemitone + intervals[degreeIndex]) % 12

  return {
    synth: lineConfig.synth,
    note: `${SEMITONE_TO_NOTE[semitone]}${lineConfig.octave}`,
    duration: lineConfig.duration,
    volume: lineConfig.volume,
  }
}
