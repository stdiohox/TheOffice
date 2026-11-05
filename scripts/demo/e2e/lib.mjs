import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
export const BASE = process.env.BASE ?? 'http://localhost:5199'
export const SHOTS = process.env.SHOTS ?? new URL('../../../node_modules/.tmp/shots/', import.meta.url).pathname
mkdirSync(SHOTS, { recursive: true })
export async function open(opts = {}) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts })
  const page = await ctx.newPage()
  const errors = []
  const watch = (p) => {
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
    p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(m.type() + ': ' + m.text().slice(0, 300)) })
  }
  watch(page)
  return { browser, ctx, page, errors, watch }
}
export const panel = (page) => page.getByRole('complementary', { name: "Presenter's controls" })
export async function openPanel(page) { if (!(await panel(page).count())) await page.getByRole('button', { name: "Open the presenter's controls" }).click() }
export async function closePanel(page) { if (await panel(page).count()) await page.getByRole('button', { name: 'Close the controls' }).click() }
