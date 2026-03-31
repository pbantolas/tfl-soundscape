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
      className="px-6 py-3 bg-neutral-900 rounded transition-opacity duration-700"
      style={{ opacity }}
    >
      <div className="flex items-center gap-3">
        {Icon && <Icon size={32} className="text-white shrink-0" />}
        <p
          className="text-5xl tracking-tight font-pixel antialiased truncate"
          style={{ color: color ?? 'rgba(255,255,255,0.8)' }}
        >
          {children}
        </p>
      </div>
    </div>
  )
}
