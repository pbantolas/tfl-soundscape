import { defineConfig, normalizePath, type HmrContext, type ModuleNode } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

function reloadAudioRuntimeOnChange() {
  const criticalFiles = new Set([
    '/src/audio/engine.ts',
    '/src/hooks/useTflEngine.ts',
    '/src/config/stations.json',
  ])

  return {
    name: 'reload-audio-runtime-on-change',
    apply: 'serve',
    handleHotUpdate(ctx: HmrContext) {
      const file = normalizePath(ctx.file)
      const shouldReload = [...criticalFiles].some((suffix) => file.endsWith(suffix))

      if (!shouldReload) return

      const invalidatedModules = new Set<ModuleNode>()
      for (const mod of ctx.modules) {
        ctx.server.moduleGraph.invalidateModule(mod, invalidatedModules, ctx.timestamp, true)
      }

      ctx.server.ws.send({ type: 'full-reload' })
      return []
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), reloadAudioRuntimeOnChange()],
})
