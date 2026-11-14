// Reload and close windows while the database is busy: each must come back in seconds.
import { open, finish, BASE, SHOTS } from './lib.mjs'
const { browser, ctx, page, errors, watch } = await open()
const office = (p) => p.getByRole('heading', { name: 'The office', exact: true })
const login = async (p, who) => { await p.getByRole('heading', { name: 'Welcome back' }).waitFor({ timeout: 90000 }); await p.getByRole('button', { name: who }).first().click(); await office(p).waitFor({ timeout: 20000 }) }
let fails = 0
const reload = async (p, n) => {
  const t = Date.now()
  try { await p.reload(); await office(p).waitFor({ timeout: 8000 }); console.log('PASS', n, Date.now() - t, 'ms') }
  catch { fails++; console.log('FAIL', n, Date.now() - t, 'ms'); await p.screenshot({ path: SHOTS + 'reload-' + n.replace(/\W+/g, '-') + '.png' }) }
}
const busy = (p) => p.evaluate(async () => { const supabase = window.__supabase; for (let i = 0; i < 25; i++) void supabase.from('office_reports').select('*').limit(500) })
await page.goto(BASE); await login(page, /Ngozi/)
const t2 = await ctx.newPage(); watch(t2); await t2.goto(BASE); await login(t2, /Bisi/)
await reload(t2, 'idle second window')
await busy(t2); await reload(t2, 'second window with 25 queries in flight')
await busy(page); await reload(page, 'first window with 25 queries in flight')
await busy(t2); await busy(page); await reload(t2, 'both busy')
await t2.bringToFront(); await page.close(); await reload(t2, 'after closing the other window')
await reload(t2, 'last window alone')
const real = errors.filter((e) => !/40[0-9]|GoTrueClient|office heartbeat/.test(e))
console.log('console problems:', [...new Set(real)].slice(0, 6).join('\n') || 'none')
console.log(fails ? `${fails} FAILED` : 'ALL PASSED')
await finish(browser, fails)
