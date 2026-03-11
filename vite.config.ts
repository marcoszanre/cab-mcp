import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { build as esbuildBuild } from 'esbuild';
import path from 'path';

const tauriPlatform = process.env.TAURI_PLATFORM
  ?? (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux')

const buildTarget = tauriPlatform === 'windows' ? 'chrome105' : 'safari13'
const normalizeModuleId = (id: string) => id.replace(/\\/g, '/')
const ACS_SHARED_PATTERNS = [
  '/@azure-rest/',
  '/@azure/abort-controller/',
  '/@azure/core-',
  '/@azure/logger/',
  '/jwt-decode/',
  '/events/',
]
const LEGAL_COMMENT_PATTERN = /\/\*![\s\S]*?\*\//g
const ACS_RUNTIME_GLOBAL_NAME = 'cabAcsCallingRuntime'

function buildAcsRuntimeAssetPlugin(): Plugin {
  let isBuild = false

  return {
    name: 'build-acs-runtime-asset',
    configResolved(config) {
      isBuild = config.command === 'build'
    },
    async buildStart() {
      if (!isBuild) {
        return
      }

      const result = await esbuildBuild({
        entryPoints: ['@azure/communication-calling'],
        bundle: true,
        format: 'iife',
        globalName: ACS_RUNTIME_GLOBAL_NAME,
        legalComments: 'external',
        logLevel: 'silent',
        mainFields: ['browser', 'module', 'main'],
        minify: true,
        outfile: 'acs-calling-runtime.js',
        platform: 'browser',
        target: buildTarget,
        write: false,
      })

      const runtimeFile = result.outputFiles?.find((file) => file.path.endsWith('.js'))
      if (!runtimeFile) {
        this.error('Failed to generate the ACS runtime asset.')
      }

      this.emitFile({
        type: 'asset',
        fileName: 'assets/acs-calling-runtime.js',
        source: runtimeFile.text,
      })

      const legalFile = result.outputFiles?.find((file) => file.path.endsWith('.LEGAL.txt'))
      if (legalFile) {
        this.emitFile({
          type: 'asset',
          fileName: 'assets/acs-calling-runtime.LEGAL.txt',
          source: legalFile.text,
        })
      }
    },
  }
}

function extractVendorLegalComments(): Plugin {
  return {
    name: 'extract-vendor-legal-comments',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk' || !output.fileName.includes('vendor-')) {
          continue
        }

        const matches = output.code.match(LEGAL_COMMENT_PATTERN)
        if (!matches?.length) {
          continue
        }

        const legalComments = Array.from(new Set(matches.map((comment) => comment.trim())))
        this.emitFile({
          type: 'asset',
          fileName: output.fileName.replace(/\.js$/, '.LEGAL.txt'),
          source: `${legalComments.join('\n\n')}\n`,
        })
        output.code = output.code.replace(LEGAL_COMMENT_PATTERN, '').trimStart()
      }
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  // Relative asset URLs are safer for packaged desktop builds where the app
  // may not be served from a stable web root.
  base: './',
  plugins: [react(), buildAcsRuntimeAssetPlugin(), extractVendorLegalComments()],
  
  // Path alias for clean imports
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src-react'),
    },
  },

  // Prevent vite from obscuring rust errors
  clearScreen: false,
  
  // Tauri expects a fixed port, fail if that port is not available
  server: {
    strictPort: true,
    port: 5173,
  },
  
  // To make use of TAURI_PLATFORM, TAURI_ARCH, etc.
  envPrefix: ['VITE_', 'TAURI_'],

  build: {
    // Tauri uses Chromium on Windows and WebKit on macOS and Linux
    target: buildTarget,
    // Don't minify for debug builds
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    // Produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const moduleId = normalizeModuleId(id)

          if (!moduleId.includes('/node_modules/')) {
            return undefined
          }

          if (
            moduleId.includes('/microsoft-cognitiveservices-speech-sdk/')
          ) {
            return 'vendor-speech'
          }

          if (moduleId.includes('/@azure/communication-calling/')) {
            return 'vendor-acs-calling'
          }

          if (moduleId.includes('/@azure/communication-chat/')) {
            return 'vendor-acs-chat'
          }

          if (moduleId.includes('/@azure/communication-identity/')) {
            return 'vendor-acs-identity'
          }

          if (
            moduleId.includes('/@azure/communication-common/') ||
            moduleId.includes('/@azure/communication-signaling/') ||
            ACS_SHARED_PATTERNS.some((pattern) => moduleId.includes(pattern))
          ) {
            return 'vendor-acs-shared'
          }

          if (
            moduleId.includes('/@azure/communication-')
          ) {
            return 'vendor-acs'
          }

          if (moduleId.includes('/@microsoft/agents-copilotstudio-client/')) {
            return 'vendor-copilot'
          }

          if (moduleId.includes('/openai/')) {
            return 'vendor-openai'
          }

          if (
            moduleId.includes('/@radix-ui/') ||
            moduleId.includes('/lucide-react/') ||
            moduleId.includes('/react-markdown/')
          ) {
            return 'vendor-ui'
          }

          return 'vendor'
        },
      },
    },
  },
});
