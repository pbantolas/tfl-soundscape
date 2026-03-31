import { ArrowDown, ArrowUp } from 'lucide-react'

type DisplayMessageProps = {
  children: React.ReactNode
  opacity?: number
  color?: string
  direction?: string
}

const directionIcons: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  inbound: ArrowDown,
  outbound: ArrowUp,
}

export function DisplayMessage({ children, opacity = 1, color, direction }: DisplayMessageProps) {
  const Icon = direction ? directionIcons[direction] : undefined

  return (
    <div
      className="px-4 py-2 sm:px-6 sm:py-3 bg-surface rounded transition-opacity duration-700"
      style={{ opacity }}
    >
      <div className="flex items-center gap-3">
        {Icon && <Icon className="w-6 h-6 sm:w-8 sm:h-8 text-fg shrink-0" />}
        <p
          className="text-3xl sm:text-5xl tracking-tight font-pixel antialiased truncate"
          style={{ color: color ?? 'var(--fg-soft)' }}
        >
          {children}
        </p>
      </div>
    </div>
  )
}
