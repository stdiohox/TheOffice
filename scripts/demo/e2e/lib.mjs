import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
export const BASE = process.env.BASE ?? 'http://localhost:5199'
export const SHOTS = process.env.SHOTS ?? new URL('../../../node_modules/.tmp/shots/', import.meta.url).pathname
mkdirSync(SHOTS, { recursive: true })
// Every run ends on its own. On 2026-11-05 five walkthrough runs printed their result, then
// hung at browser.close() for nine days; a step that never returns would do the same.
// E2E_TIMEOUT_MS overrides the 20 minute limit.
const LIMIT = Number(process.env.E2E_TIMEOUT_MS ?? 20 * 60 * 1000)
setTimeout(() => { console.error(`\nTIMED OUT after ${Math.round(LIMIT / 60000)} min`); process.exit(2) }, LIMIT).unref()

/** Close the browser (waiting at most 5 s) and exit with 1 if anything failed. */
export async function finish(browser, fails = 0) {
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
  process.exit(fails ? 1 : 0)
}

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
