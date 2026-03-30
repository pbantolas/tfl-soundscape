import { useCallback, useEffect, useRef, useState } from 'react'
import * as Tone from 'tone'
import { fetchArrivals } from '../api/tfl'
import { scheduleArrival, cancelScheduled } from '../audio/engine'
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
  const runningRef = useRef(false)

  const triggerDisplay = useCallback((stationName: string, lineName: string) => {
    setDisplay({ stationName, lineName })
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    fadeTimerRef.current = setTimeout(() => setDisplay(null), DISPLAY_DURATION_MS)
  }, [])

  const pollStation = useCallback(async (station: StationSoundConfig) => {
    try {
      const predictions = await fetchArrivals(station.stationId)

      if (!runningRef.current) return

      const now = Tone.now()

      for (const pred of predictions) {
        const lineConfig = station.lines[pred.lineId]
        if (!lineConfig) continue

        const arrivalSeconds = pred.timeToStation
        if (arrivalSeconds <= 0) continue

        const stableKey = `${station.stationId}_${pred.vehicleId}_${pred.lineId}`
        const arrivalTime = now + arrivalSeconds
        const existing = scheduled.current.get(stableKey)

        if (existing) {
          const timeUntilArrival = existing.expectedArrival - now
          const timeDiff = Math.abs(arrivalTime - existing.expectedArrival)
          if (timeUntilArrival < 10 || timeDiff < 15) continue
          cancelScheduled(existing.eventId)
          scheduled.current.delete(stableKey)
        }

        const eventId = scheduleArrival(lineConfig, arrivalTime, () => {
          triggerDisplay(station.stationName, pred.lineName)
          scheduled.current.delete(stableKey)
        })

        scheduled.current.set(stableKey, {
          predictionId: pred.id,
          eventId,
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

      const next5 = [...scheduled.current.values()]
        .sort((a, b) => a.expectedArrival - b.expectedArrival)
        .slice(0, 5)

      console.log(
        next5.length > 0
          ? `Next ${next5.length} events:\n` +
            next5.map((e) => {
              const delta = e.expectedArrival - Tone.now()
              return `  +${Math.round(delta)}s  ${e.stationName} · ${e.lineName}`
            }).join('\n')
          : 'No upcoming events'
      )
    } catch (err) {
      console.error(`Poll error for ${station.stationName}:`, err)
    }
  }, [triggerDisplay])

  const start = useCallback(async () => {
    await Tone.start()
    Tone.getTransport().start()
    runningRef.current = true
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
    runningRef.current = false

    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    if (fadeTimerRef.current) {
      clearTimeout(fadeTimerRef.current)
      fadeTimerRef.current = null
    }

    for (const entry of scheduled.current.values()) {
      cancelScheduled(entry.eventId)
    }
    scheduled.current.clear()

    Tone.getTransport().stop()
    Tone.getTransport().cancel()
    setRunning(false)
    setDisplay(null)
  }, [])

  useEffect(() => {
    return () => {
      runningRef.current = false
      if (intervalRef.current) clearInterval(intervalRef.current)
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    }
  }, [])

  return { running, display, start, stop }
}
