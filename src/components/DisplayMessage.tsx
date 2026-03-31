type DisplayMessageProps = {
  children: React.ReactNode
  opacity?: number
  color?: string
}

export function DisplayMessage({ children, opacity = 1, color }: DisplayMessageProps) {
  return (
    <div
      className="px-6 py-3 bg-neutral-900 rounded transition-opacity duration-700"
      style={{ opacity }}
    >
      <p
        className="text-5xl tracking-tight font-pixel antialiased"
        style={{ color: color ?? 'rgba(255,255,255,0.8)' }}
      >
        {children}
      </p>
    </div>
  )
}
