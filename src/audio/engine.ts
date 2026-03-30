import * as Tone from 'tone'
import type { LineSoundConfig } from '../config/types'

const RELEASE = 2.5
const FADEOUT_S = 0.05

const envelope = { attack: 0.02, decay: 0.3, sustain: 0.5, release: RELEASE }

const synthFactories: Record<string, () => Tone.Synth<Tone.SynthOptions> | Tone.FMSynth | Tone.AMSynth> = {
  Synth:    () => new Tone.Synth({ envelope }),
  FMSynth:  () => new Tone.FMSynth({ envelope }),
  AMSynth:  () => new Tone.AMSynth({ envelope }),
}

let reverb: Tone.Reverb | null = null
let limiter: Tone.Limiter | null = null

let _lastCtxState = ''

function checkCtxState() {
  const state = Tone.getContext().rawContext?.state ?? 'unknown'
  if (state !== _lastCtxState) {
    console.warn(`[audio:context] state changed: ${_lastCtxState || '(init)'} → ${state}`)
    _lastCtxState = state
  }
}

function getReverb(): Tone.Reverb {
  checkCtxState()
  if (!limiter) {
    limiter = new Tone.Limiter(-4).toDestination()
  }
  if (!reverb) {
    reverb = new Tone.Reverb({ decay: 4, preDelay: 0.02, wet: 0.45 }).connect(limiter)
    reverb.generate()
  }
  return reverb
}

const MAX_PLAYING = 24

// Synths that are currently sounding (created at trigger time, not schedule time)
let playingSynths = new Map<number, Tone.Synth | Tone.FMSynth | Tone.AMSynth>()
// Transport event IDs that haven't fired yet (no synth exists)
let pendingIds = new Set<number>()

function fadeAndDispose(synth: Tone.Synth | Tone.FMSynth | Tone.AMSynth) {
  try {
    synth.volume.cancelScheduledValues(Tone.now())
    synth.volume.setValueAtTime(synth.volume.value, Tone.now())
    synth.volume.linearRampTo(-60, FADEOUT_S)
  } catch { /* already disposed */ }
  setTimeout(() => {
    try { synth.dispose() } catch { /* already disposed */ }
  }, (FADEOUT_S + 0.02) * 1000)
}

function evictOldest() {
  const iter = playingSynths.entries()
  while (playingSynths.size >= MAX_PLAYING) {
    const { value, done } = iter.next()
    if (done) break
    const [id, synth] = value
    fadeAndDispose(synth)
    playingSynths.delete(id)
  }
}

let _debugLastLog = 0
function debugAudio(label: string, extra?: Record<string, unknown>) {
  const now = Date.now()
  if (now - _debugLastLog < 500) return
  _debugLastLog = now
  const ctx = Tone.getContext().rawContext
  console.log(`[audio:${label}]`, {
    ctxState: ctx?.state,
    currentTime: ctx?.currentTime?.toFixed(2),
    playing: playingSynths.size,
    pending: pendingIds.size,
    previews: previewIds.length,
    transportState: Tone.getTransport().state,
    ...extra,
  })
}

export function scheduleArrival(
  config: LineSoundConfig,
  arrivalTime: number,
  onTrigger: () => void
): number {
  const id = Tone.getTransport().schedule((time) => {
    pendingIds.delete(id)
    evictOldest()

    const factory = synthFactories[config.synth] ?? synthFactories.Synth
    const synth = factory().connect(getReverb())
    synth.volume.value = config.volume
    synth.triggerAttackRelease(config.note, config.duration, time)
    playingSynths.set(id, synth)
    onTrigger()

    const disposeDelay = Tone.Time(config.duration).toSeconds() + RELEASE + 0.5
    setTimeout(() => {
      synth.dispose()
      playingSynths.delete(id)
    }, disposeDelay * 1000)
  }, arrivalTime)

  pendingIds.add(id)
  return id
}

export function cancelScheduled(id: number) {
  Tone.getTransport().clear(id)
  pendingIds.delete(id)
  const synth = playingSynths.get(id)
  if (synth) {
    fadeAndDispose(synth)
    playingSynths.delete(id)
  }
}

export function cancelAll() {
  for (const id of pendingIds) {
    Tone.getTransport().clear(id)
  }
  pendingIds.clear()
  for (const [id, synth] of playingSynths) {
    Tone.getTransport().clear(id)
    synth.dispose()
  }
  playingSynths.clear()
}

export function disposeEffects() {
  if (reverb) {
    reverb.dispose()
    reverb = null
  }
  if (limiter) {
    limiter.dispose()
    limiter = null
  }
}

const MAX_PREVIEWS = 10
const previewIds: number[] = []

export function playNow(config: LineSoundConfig): void {
  debugAudio('playNow', { note: config.note, synth: config.synth })
  while (previewIds.length >= MAX_PREVIEWS) {
    cancelScheduled(previewIds.shift()!)
  }
  const id = scheduleArrival(config, Tone.now() + 0.05, () => {
    const idx = previewIds.indexOf(id)
    if (idx >= 0) previewIds.splice(idx, 1)
  })
  previewIds.push(id)
}
