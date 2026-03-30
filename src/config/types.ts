export interface LineSoundConfig {
  synth: string
  note: string
  duration: string
  volume: number
}

export interface StationSoundConfig {
  stationId: string
  stationName: string
  lines: Record<string, LineSoundConfig>
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
  lineConfig: LineSoundConfig
}

export interface TimelineEvent {
  key: string
  stationName: string
  lineName: string
  realWorldMs: number
  lineConfig: LineSoundConfig
}
