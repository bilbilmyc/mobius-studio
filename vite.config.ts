import { defineConfig } from 'vite'
export default defineConfig({
  root: 'desktop/ui',
  base: './',
  publicDir: false,
  build: { outDir: process.env.MOBIUS_UI_OUT || '../../.app-build/ui', emptyOutDir: true, target: 'es2022' },
})
