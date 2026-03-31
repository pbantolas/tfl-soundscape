export interface LineSoundConfig {
  synth: string
  degrees: number[]
  octave: number
  duration: string
  volume: number
  stationIds?: string[]
}

export interface ResolvedLineSoundConfig {
  synth: string
  note: string
  duration: string
  volume: number
}

export interface TonalityConfig {
  root: string
  mode: 'major' | 'dorian' | 'mixolydian'
}

export interface AppSoundConfig {
  tonality: TonalityConfig
  lines: Record<string, LineSoundConfig>
  lineColors: Record<string, string>
  lineColorsLight: Record<string, string>
}

export interface TflPrediction {
  id: string
  operationType: number
  vehicleId: string
  naptanId: string
  stationName: string
  lineId: string
  lineName: string
  platformName: string
  direction: string
  bearing: string
  tripId: string
  destinationNaptanId: string
  destinationName: string
  timeToStation: number
  expectedArrival: string
  timeToLive: string
  currentLocation: string
  towards: string
  modeName: string
  timestamp: string
}

export interface ScheduledArrival {
  predictionId: string
  eventId: number
  stationName: string
  lineId: string
  lineName: string
  expectedArrival: number
  scheduledAt: number
  realWorldMs: number
  lineConfig: ResolvedLineSoundConfig
}

export interface TimelineEvent {
  key: string
  stationId: string
  stationName: string
  lineId: string
  lineName: string
  direction: string
  realWorldMs: number
  lineConfig: ResolvedLineSoundConfig
}
