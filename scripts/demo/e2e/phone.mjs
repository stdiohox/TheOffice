// Every screen at phone width: nothing wider than the screen.
import { open, BASE, SHOTS, openPanel, closePanel } from './lib.mjs'
const { browser, page } = await open({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
let fails = 0
await page.goto(BASE); await page.getByRole('heading', { name: 'Welcome back' }).waitFor({ timeout: 120000 })
await page.getByRole('button', { name: /Ngozi Adeleke/ }).first().click(); await page.getByText('Your desk').first().waitFor({ timeout: 20000 })
for (const r of ['office', 'reports', 'tasks', 'chat', 'leaderboard', 'notices', 'time-off', 'rooms', 'insights', 'settings', 'email-log']) {
  await page.goto(BASE + '/' + r); await page.waitForTimeout(2500)
  const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, main: document.querySelector('main')?.scrollWidth ?? 0 }))
  const over = m.doc > 391 || m.main > 391
  if (over) fails++
  console.log(over ? 'OVERFLOW' : 'ok', r, JSON.stringify(m))
  await page.screenshot({ path: SHOTS + 'm-' + r + '.png' })
}
await page.goto(BASE + '/office'); await page.waitForTimeout(1500)
await page.getByRole('button', { name: /^More/ }).click(); await page.waitForTimeout(300); await page.screenshot({ path: SHOTS + 'm-more.png' }); await page.getByRole('button', { name: /^More/ }).click()
await openPanel(page); await page.waitForTimeout(300); await page.screenshot({ path: SHOTS + 'm-panel.png' }); await closePanel(page)
console.log(fails ? `${fails} FAILED` : 'ALL PASSED')
await browser.close(); process.exit(fails ? 1 : 0)
