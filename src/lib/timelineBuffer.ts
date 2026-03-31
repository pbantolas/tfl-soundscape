import type { TimelineEvent } from '../config/types'

interface TimelineWindow {
  minMs: number
  maxMs: number
}

function isWithinWindow(event: TimelineEvent, window: TimelineWindow): boolean {
  return event.realWorldMs >= window.minMs && event.realWorldMs <= window.maxMs
}

function sameLineConfig(a: TimelineEvent['lineConfig'], b: TimelineEvent['lineConfig']): boolean {
  return a.synth === b.synth
    && a.note === b.note
    && a.duration === b.duration
    && a.volume === b.volume
}

function sameEvent(a: TimelineEvent, b: TimelineEvent): boolean {
  return a.key === b.key
    && a.stationId === b.stationId
    && a.stationName === b.stationName
    && a.lineId === b.lineId
    && a.lineName === b.lineName
    && a.realWorldMs === b.realWorldMs
    && sameLineConfig(a.lineConfig, b.lineConfig)
}

export function applyTimelineWindow(
  currentEvents: TimelineEvent[],
  incomingEvents: TimelineEvent[],
  lineId: string,
  window: TimelineWindow,
): { events: TimelineEvent[]; changed: boolean } {
  const currentWindowed = currentEvents.filter(event => isWithinWindow(event, window))
  const retainedEvents = currentWindowed.filter(event => event.lineId !== lineId)
  const byKey = new Map(retainedEvents.map(event => [event.key, event]))

  for (const event of incomingEvents) {
    if (!isWithinWindow(event, window)) continue
    byKey.set(event.key, event)
  }

  const nextEvents = [...byKey.values()].sort((a, b) => a.realWorldMs - b.realWorldMs)
  const changed = nextEvents.length !== currentWindowed.length
    || nextEvents.some((event, index) => !sameEvent(event, currentWindowed[index]))

  return { events: nextEvents, changed }
}

export function getTimelineBounds(events: TimelineEvent[]): { startMs: number; endMs: number } {
  if (events.length === 0) {
    return { startMs: 0, endMs: 0 }
  }

  return {
    startMs: events[0].realWorldMs,
    endMs: events[events.length - 1].realWorldMs,
  }
}
