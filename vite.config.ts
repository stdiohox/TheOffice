import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

// A new database snapshot gets a new database in the browser.
const snapshot = path.resolve(import.meta.dirname, 'public/demo/office.tar.gz')
const dbVersion = existsSync(snapshot) ? createHash('sha256').update(readFileSync(snapshot)).digest('hex').slice(0, 12) : 'dev'
// What the route files in server/ read from process.env, fixed at build time: the bundler
// removes process.env from a production build, so setting it at run time only works in dev.
const serverEnv = {
  SUPABASE_URL: 'https://brightwork.demo.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'demo',
  RESEND_API_KEY: 'demo',
  OFFICE_FROM_EMAIL: 'Brightwork Office <office@brightwork.example>',
  CRON_SECRET: 'demo-cron-secret-0123456789abcdef0123',
}
const define = {
  __DEMO_DB_VERSION__: JSON.stringify(dbVersion),
  ...Object.fromEntries(Object.entries(serverEnv).map(([k, v]) => [`process.env.${k}`, JSON.stringify(v)])),
  // Emails link back here. The route insists on https, which localhost is not; the links only matter deployed.
  'process.env.OFFICE_BASE_URL': `location.origin.replace(/^http:/, 'https:')`,
  'process.env.OFFICE_MANAGER_EMAIL': 'undefined',
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define,
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      resend: path.resolve(import.meta.dirname, './src/demo/shims/resend.ts'),
      'node:crypto': path.resolve(import.meta.dirname, './src/demo/shims/node-crypto.ts'),
    },
  },
})
