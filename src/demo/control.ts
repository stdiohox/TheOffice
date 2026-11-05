import { queryClient } from '@/lib/queryClient'
import { useAuthStore } from '@/stores/authStore'
import { CLOCK_MOVED, clockOffset, realNow, setClockOffset } from './clock'
import { publish, subscribeBus } from './bus'
import { installApiFetch } from './client'
import { asOwner, syncDb } from './engine'
import { claimSeat, helloPresence } from './realtime'
import { PASSWORD, type Person } from './people'
import { seed } from './seed'
import { catchUp, runClockJobs, startSimulation } from './sim'

/** The office runs on Lagos time, which has no daylight saving. */
const LAGOS_MS = 3_600_000
/** Twenty minutes before sign-in closes: the presenter can still file on time. */
export const OPENING_MINUTES = 10 * 60 + 40

export const lagosDay = (ms = Date.now()) => new Date(ms + LAGOS_MS).toISOString().slice(0, 10)
export const lagosMinutes = (ms = Date.now()) => {
  const d = new Date(ms + LAGOS_MS)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}
const instant = (day: string, minutes: number) => new Date(`${day}T00:00:00Z`).getTime() - LAGOS_MS + minutes * 60_000

function shiftDay(day: string, n: number) {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const isoDow = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay() || 7

/** Today if it is a workday, or else the Friday before. */
function workingDay(day: string) {
  const dow = isoDow(day)
  return dow > 5 ? shiftDay(day, 5 - dow) : day
}

async function writeOffset(offset: number) {
  setClockOffset(offset)
  await asOwner((tx) => tx.query(`update demo.clock set offset_ms = $1`, [offset]))
}

async function freshStart() {
  const day = workingDay(new Date(realNow() + LAGOS_MS).toISOString().slice(0, 10))
  await writeOffset(instant(day, OPENING_MINUTES) - realNow())
  await seed(day, OPENING_MINUTES)
}

let invalidateTimer: ReturnType<typeof setTimeout> | null = null
/** Heartbeats move no screen; refreshing on them would only make noise. */
const QUIET = new Set(['office_presence', 'office_activity_state'])

export async function bootDemo() {
  const root = document.getElementById('root')!
  installApiFetch()
  try {
    const [{ has }] = await asOwner(async (tx) => (await tx.query<{ has: boolean }>(`select exists (select 1 from public.profiles) as has`)).rows)
    if (!has) await freshStart()
    else {
      const [{ offset_ms }] = await asOwner(async (tx) => (await tx.query<{ offset_ms: string | number }>(`select offset_ms from demo.clock`)).rows)
      setClockOffset(Number(offset_ms))
    }
  } catch (e) {
    console.error(e)
    root.innerHTML = `<div style="font-family:Nunito,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1rem;text-align:center"><h1 style="font-size:1.5rem">The office could not open</h1><p>This demo keeps its database in your browser, and that needs a current Chrome, Edge, Safari or Firefox outside private browsing.</p><p><a href="/">Try again</a></p></div>`
    throw e
  }

  // The rest of the team and the other windows move the screens too.
  subscribeBus((m) => {
    if (m.t === 'reset') {
      // Every window starts the story again, signed out.
      void useAuthStore.getState().signOut().finally(() => location.assign('/'))
    }
    if (m.t === 'clock') {
      setClockOffset(m.offset)
      window.dispatchEvent(new Event(CLOCK_MOVED))
      void queryClient.invalidateQueries()
    }
    if (m.t === 'changes' && m.rows.some((c) => !QUIET.has(c.tbl))) {
      if (invalidateTimer) clearTimeout(invalidateTimer)
      invalidateTimer = setTimeout(() => void queryClient.invalidateQueries(), 500)
    }
  })

  // Signing out or becoming someone else leaves the room you were in. A profile that
  // goes null then back to the same person is a reload of the store, not a departure.
  let seated: string | null = null
  useAuthStore.subscribe((s) => {
    const now = s.profile?.id ?? s.user?.id ?? null
    claimSeat(now)
    if (seated && !s.user && now !== seated) {
      const left = seated
      void asOwner((tx) => tx.query(`delete from public.office_room_occupants where user_id = $1`, [left]))
    }
    if (now !== seated) seated = now
  })
  helloPresence()
  startSimulation()
}

/** Be someone else in this window. */
export async function become(person: Person) {
  const store = useAuthStore.getState()
  if (store.profile?.id === person.id) return
  if (store.session) await store.signOut()
  const { error } = await useAuthStore.getState().signIn(person.email, PASSWORD)
  if (error) throw new Error(error)
}

/** Move the clock to a time today, or to a given day. */
export async function jumpTo(minutes: number, day = lagosDay()) {
  const from = Date.now()
  const offset = clockOffset() + (instant(day, minutes) - from)
  await writeOffset(offset)
  publish({ t: 'clock', offset })
  await catchUp(from)
  await runClockJobs()
  // Again: the catch-up writes with triggers off, so no change message tells other windows.
  publish({ t: 'clock', offset })
  void queryClient.invalidateQueries()
}

/** This week's Friday, on the demo clock. */
export function thisFriday() {
  const day = lagosDay()
  return shiftDay(day, 5 - isoDow(day))
}

export async function resetDemo() {
  await freshStart()
  // The reload must not outrun the writes.
  await syncDb()
  publish({ t: 'reset' })
}
