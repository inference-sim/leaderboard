import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // results/ and prototypes/ are siblings of web/, above the Vite root.
    fs: { allow: ['..'] },
    // The Declare-a-run screen runs blis through `leaderboard serve`, which owns the
    // upstream checkout. Proxying keeps the browser same-origin, so no CORS dance.
    proxy: { '/api': 'http://localhost:8080' },
  },
  test: {
    globals: true,
    environment: 'node', // format.ts and model.ts are pure; renderToStaticMarkup needs no DOM
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
