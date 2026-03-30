import * as Tone from 'tone'
import type { LineSoundConfig } from '../config/types'

const RELEASE = 2.5

const envelope = { attack: 0.02, decay: 0.3, sustain: 0.5, release: RELEASE }

const synthFactories: Record<string, () => Tone.Synth<Tone.SynthOptions> | Tone.FMSynth | Tone.AMSynth> = {
  Synth:    () => new Tone.Synth({ envelope }),
  FMSynth:  () => new Tone.FMSynth({ envelope }),
  AMSynth:  () => new Tone.AMSynth({ envelope }),
}

let reverb: Tone.Reverb | null = null

function getReverb(): Tone.Reverb {
  if (!reverb) {
    const limiter = new Tone.Limiter(-4).toDestination()
    reverb = new Tone.Reverb({ decay: 4, preDelay: 0.02, wet: 0.45 }).connect(limiter)
    reverb.generate()
  }
  return reverb
}

export function scheduleArrival(
  config: LineSoundConfig,
  arrivalTime: number,
  onTrigger: () => void
): number {
  const factory = synthFactories[config.synth] ?? synthFactories.Synth
  const synth = factory().connect(getReverb())
  synth.volume.value = config.volume

  const id = Tone.getTransport().schedule((time) => {
    synth.triggerAttackRelease(config.note, config.duration, time)
    onTrigger()

    const disposeDelay = Tone.Time(config.duration).toSeconds() + RELEASE + 0.5
    setTimeout(() => synth.dispose(), disposeDelay * 1000)
  }, arrivalTime)

  return id
}

export function cancelScheduled(id: number) {
  Tone.getTransport().clear(id)
}
