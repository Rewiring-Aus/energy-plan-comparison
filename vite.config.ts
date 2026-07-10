import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// `base` is '/' for local dev/preview; the GitHub Pages build sets VITE_BASE to the project path
// (e.g. /energy-plan-comparison/) so assets resolve under rewiring-aus.github.io/<repo>/.
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
})
