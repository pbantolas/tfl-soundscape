import { useEffect, useState } from 'react'

interface Props {
  lineEnergies: Record<string, number>
  currentBpm: number
  lineColors: Record<string, string>
}

export function EnergyDebug({ lineEnergies, currentBpm, lineColors }: Props) {
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    ;(window as any).showEnergyDebug = (on = true) => setEnabled(on)
    return () => { delete (window as any).showEnergyDebug }
  }, [])

  if (!enabled || Object.keys(lineEnergies).length === 0) return null

  return (
    <div className="fixed top-4 right-4 flex flex-col gap-1 text-xs opacity-60">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="w-16 text-right">BPM</span>
        <span className="w-20 text-center tabular-nums">{currentBpm}</span>
      </div>
      {Object.entries(lineEnergies).map(([lineId, energy]) => (
        <div key={lineId} className="flex items-center gap-1.5">
          <span className="w-16 text-right capitalize">{lineId}</span>
          <div className="w-20 h-1.5 bg-fg/10 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-100"
              style={{ width: `${energy * 100}%`, backgroundColor: lineColors[lineId] }}
            />
          </div>
          <span className="w-6 text-left">{(energy * 100).toFixed(0)}</span>
        </div>
      ))}
    </div>
  )
}
