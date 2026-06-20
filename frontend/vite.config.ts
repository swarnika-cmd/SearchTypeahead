import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/suggest': 'http://localhost:3000',
      '/api': 'http://localhost:3000',
    }
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  }
})
