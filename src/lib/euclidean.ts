export function buildEuclideanPattern(steps: number, hits: number, rotation: number): boolean[] {
  const safeSteps = Math.max(1, Math.floor(steps))
  const safeHits = Math.max(0, Math.min(safeSteps, Math.floor(hits)))
  const normalizedRotation = ((Math.floor(rotation) % safeSteps) + safeSteps) % safeSteps

  if (safeHits === 0) return Array.from({ length: safeSteps }, () => false)
  if (safeHits === safeSteps) return Array.from({ length: safeSteps }, () => true)

  const pattern = Array.from({ length: safeSteps }, (_, step) => ((step * safeHits) % safeSteps) < safeHits)
  if (normalizedRotation === 0) return pattern

  return pattern.map((_, step) => pattern[(step - normalizedRotation + safeSteps) % safeSteps])
}
