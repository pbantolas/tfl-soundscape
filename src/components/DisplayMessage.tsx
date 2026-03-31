type DisplayMessageProps = {
  children: React.ReactNode
  opacity?: number
}

export function DisplayMessage({ children, opacity = 1 }: DisplayMessageProps) {
  return (
    <div
      className="px-6 py-3 bg-neutral-900 rounded transition-opacity duration-700"
      style={{ opacity }}
    >
      <p className="text-5xl text-white/80 tracking-tight font-pixel antialiased">
        {children}
      </p>
    </div>
  )
}
