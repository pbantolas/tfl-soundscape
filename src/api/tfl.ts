import type { TflPrediction } from '../config/types'

const BASE = 'https://api.tfl.gov.uk'

export async function fetchLineArrivals(lineId: string): Promise<TflPrediction[]> {
  const res = await fetch(`${BASE}/Line/${lineId}/Arrivals`)
  if (!res.ok) throw new Error(`TFL API error: ${res.status}`)
  const data: TflPrediction[] = await res.json()
  return data.sort((a, b) => a.timeToStation - b.timeToStation)
}
