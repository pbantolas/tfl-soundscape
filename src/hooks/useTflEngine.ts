import { useCallback, useEffect, useRef, useState } from 'react'
import * as Tone from 'tone'
import { fetchArrivals } from '../api/tfl'
import { scheduleArrival } from '../audio/engine'
import type { StationSoundConfig, ScheduledArrival } from '../config/types'
import stationsConfig from '../config/stations.json'

const stations = stationsConfig as StationSoundConfig[]
const POLL_WINDOW_MS = 30_000
const DISPLAY_DURATION_MS = 3000

export function useTflEngine() {
  const [running, setRunning] = useState(false)
  const [display, setDisplay] = useState<{ stationName: string; lineName: string } | null>(null)
  const scheduled = useRef(new Map<string, ScheduledArrival>())
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const triggerDisplay = useCallback((stationName: string, lineName: string) => {
    setDisplay({ stationName, lineName })
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    fadeTimerRef.current = setTimeout(() => setDisplay(null), DISPLAY_DURATION_MS)
  }, [])

  const pollStation = useCallback(async (station: StationSoundConfig) => {
    try {
      const predictions = await fetchArrivals(station.stationId)
      const now = Tone.now()

      for (const pred of predictions) {
        if (scheduled.current.has(pred.id)) continue

        const lineConfig = station.lines[pred.lineId]
        if (!lineConfig) continue

        const arrivalSeconds = pred.timeToStation
        if (arrivalSeconds <= 0) continue

        const arrivalTime = now + arrivalSeconds

        scheduleArrival(lineConfig, arrivalTime, () => {
          triggerDisplay(station.stationName, pred.lineName)
        })

        scheduled.current.set(pred.id, {
          predictionId: pred.id,
          stationName: station.stationName,
          lineId: pred.lineId,
          lineName: pred.lineName,
          expectedArrival: arrivalTime,
          scheduledAt: Date.now(),
        })
      }

      const transportNow = Tone.now()
      for (const [key, entry] of scheduled.current) {
        if (entry.expectedArrival < transportNow - 10) {
          scheduled.current.delete(key)
        }
      }
    } catch (err) {
      console.error(`Poll error for ${station.stationName}:`, err)
    }
  }, [triggerDisplay])

  const start = useCallback(async () => {
    await Tone.start()
    Tone.getTransport().start()
    setRunning(true)

    const stagger = POLL_WINDOW_MS / stations.length

    stations.forEach((station, i) => {
      setTimeout(() => pollStation(station), i * stagger)
    })

    intervalRef.current = setInterval(() => {
      stations.forEach((station, i) => {
        setTimeout(() => pollStation(station), i * stagger)
      })
    }, POLL_WINDOW_MS)
  }, [pollStation])

  const stop = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    if (fadeTimerRef.current) {
      clearTimeout(fadeTimerRef.current)
      fadeTimerRef.current = null
    }
    Tone.getTransport().stop()
    Tone.getTransport().cancel()
    scheduled.current.clear()
    setRunning(false)
    setDisplay(null)
  }, [])

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    }
  }, [])

  return { running, display, start, stop }
}
