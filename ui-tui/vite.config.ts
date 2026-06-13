import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: 'src',
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    open: true,
  },
})