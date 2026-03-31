import type { TflPrediction } from '../config/types'

const BASE = 'https://api.tfl.gov.uk'

function buildTflUrl(path: string): string {
  const url = new URL(path, BASE)

  if (import.meta.env.VITE_TFL_APP_KEY) {
    url.searchParams.set('app_key', import.meta.env.VITE_TFL_APP_KEY)
  }

  return url.toString()
}

export async function fetchLineArrivals(lineId: string): Promise<TflPrediction[]> {
  const res = await fetch(buildTflUrl(`/Line/${lineId}/Arrivals`))
  if (!res.ok) throw new Error(`TFL API error: ${res.status}`)
  const data: TflPrediction[] = await res.json()
  return data.sort((a, b) => a.timeToStation - b.timeToStation)
}
