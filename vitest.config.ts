import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src-react/__tests__/setup.ts'],
    include: ['src-react/**/*.{test,spec}.{ts,tsx}'],
    // Avoid Windows temp folder issues
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src-react/**/*.{ts,tsx}'],
      exclude: [
        'src-react/**/*.d.ts',
        'src-react/__tests__/**',
        'src-react/vite-env.d.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src-react'),
    },
  },
})
