import type { Change } from './bus'
import { subscribeBus } from './bus'
import { CRON_SECRET, fakeJwt } from './auth'
import { asOwner, type Who } from './engine'
import { humansPresent, setSimPresence } from './realtime'
import { callRpc } from './rest'
import { BISI, IFE, CHINEDU, LATE_STARTERS, NGOZI, PEOPLE, TUNDE, WORK, type Person } from './people'
import { lagosDay, lagosMinutes } from './control'

/**
 * The rest of the team. One window at a time (a Web Lock) plays everyone no person
 * is being: they come in, file their reports, answer knocks, do the tasks they are
 * given, read notices and chat. All through the same functions a real person's
 * browser calls, so the rules apply to them too.
 */

const who = (p: Person): Who => ({ role: 'authenticated', sub: p.id })
const rpc = (p: Person, name: string, args: Record<string, unknown> = {}) => callRpc(who(p), name, args)
const byId = (id: unknown) => PEOPLE.find((p) => p.id === id)
const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)]
const later = (ms: number, fn: () => Promise<unknown>) =>
  setTimeout(() => void fn().catch((e: unknown) => console.warn('demo team:', e)), ms)
const free = (p: Person) => !humansPresent().has(p.id)
/** As `later`, for something done as p: if someone has become p meanwhile, it is theirs to do. */
const laterAs = (p: Person, ms: number, fn: () => Promise<unknown>) => later(ms, async () => (free(p) ? fn() : undefined))

const FILERS = PEOPLE.filter((p) => p !== NGOZI)
const WINDOWS = [
  { kind: 'signin', opens: 9 * 60, deadline: 11 * 60 },
  { kind: 'midday', opens: 15 * 60, deadline: 16 * 60 },
  { kind: 'eod', opens: 17 * 60, deadline: 19 * 60 },
] as const

const LAGOS = '+01:00'
const pad = (n: number) => String(n).padStart(2, '0')
const stamp = (day: string, m: number) => `${day}T${pad(Math.floor(m / 60))}:${pad(m % 60)}:00${LAGOS}`
const isWeekend = (day: string) => [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay())
const nextDay = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

async function isAway(tx: { query: <T>(q: string, p?: unknown[]) => Promise<{ rows: T[] }> }, id: string, day: string) {
  return (await tx.query(`select 1 from public.office_absences where user_id = $1 and $2::date between starts_on and ends_on`, [id, day])).rows.length > 0
}

/**
 * The clock jumped: the team did their day in between. What passed is written with
 * its true times; a window still open is left to the ticks.
 */
export async function catchUp(fromMs: number) {
  const toDay = lagosDay()
  const nowM = lagosMinutes()
  const humans = humansPresent()
  const startDay = lagosDay(fromMs)
  const seen = new Set(
    await asOwner(async (tx) => (await tx.query<{ user_id: string }>(`select user_id from public.office_reports where work_date = $1 and kind = 'signin'`, [startDay])).rows.map((r) => r.user_id)),
  )
  // Whoever was in a meeting has long left it.
  await asOwner((tx) => tx.query(`delete from public.office_room_occupants`))
  for (let day = startDay; day <= toDay; day = nextDay(day)) {
    if (isWeekend(day)) continue
    const until = day === toDay ? nowM : 24 * 60
    await asOwner(async (tx) => {
      await tx.exec(`set local session_replication_role = replica`)
      for (const p of FILERS) {
        if (humans.has(p.id) || (await isAway(tx, p.id, day))) continue
        // The day the clock leaves from: late starters stay out, so there is a missed flag to find.
        if (day === startDay && LATE_STARTERS.includes(p) && !seen.has(p.id)) continue
        for (const w of WINDOWS) {
          if (w.deadline >= until) continue
          // Chinedu is the one who slips, so there is always something to find.
          if (Math.random() < (p === CHINEDU ? 0.25 : 0.03)) continue
          const at = w.opens + Math.floor(Math.random() * (w.deadline - w.opens - 2))
          const body = pick(WORK[p.beat][w.kind])
          const done = await tx.query(
            `insert into public.office_reports (user_id, work_date, kind, body, submitted_at, timing)
             values ($1, $2, $3, $4, $5, 'on_time') on conflict do nothing returning id`,
            [p.id, day, w.kind, body, stamp(day, at)],
          )
          if (!done.rows.length) continue
          if (w.kind === 'signin') {
            // A day that never got its end-of-day report still ends: one open stay per person.
            await tx.query(`update public.office_entries set left_at = greatest(entered_at, $2::timestamptz), left_reason = 'day_end' where user_id = $1 and left_at is null`, [p.id, stamp(day, at - 1)])
            await tx.query(`insert into public.office_entries (user_id, work_date, entered_at, entered_by) values ($1, $2, $3, 'signin')`, [p.id, day, stamp(day, at)])
            await tx.query(`insert into public.office_status (user_id, working_on, set_on, updated_at) values ($1, $2, $3, $4)
              on conflict (user_id) do update set working_on = excluded.working_on, set_on = excluded.set_on, back_at = null, out_until = null, updated_at = excluded.updated_at`,
              [p.id, pick(WORK[p.beat].doing), day, stamp(day, at + 2)])
          }
          if (w.kind === 'eod') {
            await tx.query(`update public.office_entries set left_at = $3, left_reason = 'eod' where user_id = $1 and work_date = $2 and left_at is null`, [p.id, day, stamp(day, at + 3)])
          }
        }
      }
    })
    if (day !== toDay) {
      // A closed day raises its flags on its own clock in the real office; here, in one go.
      await asOwner((tx) =>
        tx.query(`insert into public.office_flags (user_id, work_date, kind, flag, raised_at, notified_at)
          select p.id, $1::date, k.kind, 'missed', $2::timestamptz, $2::timestamptz
          from public.profiles p cross join (values ('signin'), ('midday'), ('eod')) k(kind)
          where public.office_expects_report(p.id, $1::date)
            and not exists (select 1 from public.office_reports r where r.user_id = p.id and r.work_date = $1::date and r.kind = k.kind)
          on conflict do nothing`, [day, stamp(day, 19 * 60 + 5)]),
      )
    }
  }
  await syncPresence()
}

/** What pg_cron and the alerts route do in the real office. */
export async function runClockJobs() {
  await asOwner(async (tx) => {
    await tx.query(`select public.raise_report_flags()`)
    await tx.query(`select public.office_activity_sweep()`)
  })
  await fetch('/api/cron/office-alerts', { method: 'POST', headers: { Authorization: `Bearer ${CRON_SECRET}` } }).catch((e: unknown) =>
    console.warn('demo alerts:', e),
  )
}

const statuses = new Map<string, string>()

/** Who of the team is at their desk right now, and heartbeats for them. */
async function syncPresence() {
  const day = lagosDay()
  const rows = await asOwner(async (tx) => (await tx.query<{ user_id: string; kind: string }>(`select user_id, kind from public.office_reports where work_date = $1`, [day])).rows)
  const humans = humansPresent()
  for (const p of PEOPLE) {
    const mine = rows.filter((r) => r.user_id === p.id).map((r) => r.kind)
    const inOffice = !humans.has(p.id) && (p === NGOZI ? lagosMinutes() < 19 * 60 : mine.includes('signin') && !mine.includes('eod'))
    if (!inOffice) {
      statuses.delete(p.id)
      setSimPresence(p.id, null)
      continue
    }
    // People mostly stay as they were; a door that flickers every minute reads as fake.
    const roll = Math.random()
    const status = statuses.has(p.id) && Math.random() > 0.15 ? statuses.get(p.id)! : roll < 0.8 ? 'online' : roll < 0.92 ? 'busy' : 'away'
    statuses.set(p.id, status)
    setSimPresence(p.id, { status })
    await rpc(p, 'office_heartbeat', { p_status: status }).catch(() => undefined)
  }
}

async function tellRoute(p: Person, taskId: string) {
  const rows = await asOwner(async (tx) => (await tx.query<{ id: string }>(`select id from public.office_task_events where task_id = $1 order by created_at desc limit 1`, [taskId])).rows)
  if (!rows[0]) return
  await fetch('/api/office/task-notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fakeJwt({ sub: p.id, email: p.email, role: 'authenticated' })}` },
    body: JSON.stringify({ eventId: rows[0].id }),
  })
}

const CHAT = {
  open: ['Hi, have you got a minute?', 'Quick one: can you look at something for me?', 'Sorry to knock. Do you have the latest figures?'],
  reply: ['Yes, give me two minutes.', 'That works for me. I will send it over.', 'Good idea. Let me check and come back to you.', 'Agreed. I will update the task as well.', 'Thanks, that helps a lot.'],
  decline: ['In a meeting until the hour', 'Finishing something, give me 15 minutes', 'On a call, will come to you after'],
  channel: {
    general: ['Good news: the courier is on time today.', 'Has anyone seen the updated price list?', 'Reminder: webinar rehearsal after lunch.', 'I am in the Focus room if anyone needs me.'],
    wins: ['A customer just wrote in to thank Segun by name.', 'Signed a renewal this morning.', 'Error rate is back to normal after the fix.', 'Newsletter open rate hit a new high.'],
    help: ['Does anyone have the new contract template?', 'Who can review a short email before it goes out?', 'Which folder are the October invoices in?'],
    answer: ['On it.', 'Nice one!', 'Thanks for sharing that.', 'I can help with this, sending it now.'],
  },
}

const chatted = new Map<string, number>()
let knocksAnswered = 0
let invitesAnswered = 0

function onChange(c: Change) {
  const row = (c.new ?? {}) as Record<string, string>

  if (c.tbl === 'office_knocks' && c.op === 'INSERT') {
    const to = byId(row.to_user)
    if (to && free(to)) {
      // Every fourth knock gets "not now". Never the first: that one is usually in front of a room.
      const accept = ++knocksAnswered % 4 !== 0
      laterAs(to, 2500 + Math.random() * 2000, () =>
        accept ? rpc(to, 'respond_knock', { p_id: row.id, p_accept: true }) : rpc(to, 'respond_knock', { p_id: row.id, p_accept: false, p_reply: pick(CHAT.decline) }),
      )
    }
  }
  if (c.tbl === 'office_knocks' && c.op === 'UPDATE' && row.status === 'accepted' && (c.old as Record<string, string>)?.status === 'pending') {
    // Whoever knocked and is not a person opens the conversation.
    const from = byId(row.from_user)
    if (from && free(from)) laterAs(from, 1800, () => asOwnerChat(row.id, from, pick(CHAT.open)))
  }
  if (c.tbl === 'office_chat_messages' && c.op === 'INSERT' && humansPresent().has(row.sender)) {
    const knockId = row.knock_id
    const n = chatted.get(knockId) ?? 0
    if (n < 4) {
      chatted.set(knockId, n + 1)
      later(2200 + Math.random() * 1800, async () => {
        const k = await asOwner(async (tx) => (await tx.query<{ from_user: string; to_user: string; status: string; ended_at: string | null }>(`select from_user, to_user, status, ended_at from public.office_knocks where id = $1`, [knockId])).rows[0])
        if (!k || k.ended_at) return
        const other = byId(k.from_user === row.sender ? k.to_user : k.from_user)
        if (other && free(other)) await asOwnerChat(knockId, other, pick(CHAT.reply))
      })
    }
  }
  if (c.tbl === 'office_room_invites' && c.op === 'INSERT') {
    const to = byId(row.to_user)
    if (to && free(to)) {
      const accept = ++invitesAnswered % 4 !== 0
      laterAs(to, 4000 + Math.random() * 3000, async () => {
        await rpc(to, 'respond_room_invite', { p_id: row.id, p_accept: accept })
        if (accept) later(2000, () => postInRoom(row.room_id, to, pick(ROOM.arrive)))
      })
    }
  }
  if (c.tbl === 'office_room_messages' && c.op === 'INSERT' && humansPresent().has(row.sender)) {
    later(2200 + Math.random() * 2500, async () => {
      const inside = await occupants(row.room_id)
      const other = pick(inside.map(byId).filter((p): p is Person => !!p && free(p)))
      if (other) await postInRoom(row.room_id, other, pick(ROOM.reply))
    })
  }
  if (c.tbl === 'office_tasks' && c.op === 'INSERT') {
    const to = byId(row.assigned_to)
    if (to && free(to) && row.assigned_to !== row.assigned_by) {
      laterAs(to, 6000 + Math.random() * 4000, () => rpc(to, 'start_task', { p_id: row.id }))
      laterAs(to, 22000 + Math.random() * 10000, async () => {
        await rpc(to, 'complete_task', { p_id: row.id, p_note: 'Done. Tell me if you want anything changed.' })
        await tellRoute(to, row.id)
      })
    }
  }
  if (c.tbl === 'office_notices' && c.op === 'INSERT') {
    for (const p of PEOPLE) {
      if (free(p) && p.id !== row.author) {
        laterAs(p, 3000 + Math.random() * 40000, () => asOwner((tx) => tx.query(`insert into public.office_notice_reads (notice_id, user_id, read_at) values ($1, $2, demo.now()) on conflict do nothing`, [row.id, p.id])))
      }
    }
  }
  if (c.tbl === 'office_leave_requests' && c.op === 'INSERT' && row.status === 'pending') {
    if (free(BISI) && humansPresent().has(row.user_id)) {
      laterAs(BISI, 9000, () => rpc(BISI, 'decide_leave', { p_id: row.id, p_approve: true, p_note: 'Approved. Enjoy the time off.' }))
    }
  }
  if (c.tbl === 'office_channel_messages' && c.op === 'INSERT' && humansPresent().has(row.sender)) {
    const reply = pick(PEOPLE.filter((p) => free(p) && p.id !== row.sender))
    if (reply) laterAs(reply, 3500 + Math.random() * 3000, () => post(row.channel, reply, pick(CHAT.channel.answer)))
  }
}

const ROOM = {
  arrive: ['Hi, I am here. What have I missed?', 'Just caught up on the above. How can I help?', 'Thanks for the invite. I have read back.'],
  reply: ['Good point. I can take that on today.', 'Agreed. Shall we note that as the next step?', 'That makes sense to me.', 'I will check and report back here in a few minutes.', 'Yes, and I can send the details after this.'],
  chatter: ['I have just checked, and that part looks fine.', 'Can we settle this before the end of the day?', 'I will write up what we agreed.', 'One more thing: who is telling the customer?', 'Good, that is one less thing to worry about.'],
}

const occupants = (room: string) =>
  asOwner(async (tx) => (await tx.query<{ user_id: string }>(`select user_id from public.office_room_occupants where room_id = $1`, [room])).rows.map((r) => r.user_id))

function postInRoom(room: string, p: Person, body: string) {
  return asOwner((tx) => tx.query(`insert into public.office_room_messages (room_id, sender, body) values ($1, $2, $3)`, [room, p.id, body]))
}

/** The team know the code to a room they use, and go through the same door as anyone. */
async function walkIn(p: Person, room: string) {
  const code = await asOwner(async (tx) => (await tx.query<{ code: string }>(`select code from public.office_room_codes where room_id = $1`, [room])).rows[0]?.code)
  await rpc(p, 'enter_room', { p_room: room, p_code: code ?? null })
}

/** Two of the team talking in a room, or a room where they already are. */
async function aRoomInUse(me: string): Promise<{ room: string; person: Person }> {
  const rows = await asOwner(async (tx) => (await tx.query<{ user_id: string; room_id: string }>(`select user_id, room_id from public.office_room_occupants`)).rows)
  // Never the room this person is already in: there would be nothing to invite them to.
  const mine = rows.find((r) => r.user_id === me)?.room_id
  const there = rows.filter((r) => r.room_id !== mine).map((r) => ({ room: r.room_id, person: byId(r.user_id) })).find((r) => r.person && free(r.person))
  if (there?.person) return { room: there.room, person: there.person }
  const room = mine === 'focus' ? 'boardroom' : 'focus'
  const [a, b] = PEOPLE.filter((p) => p !== NGOZI && free(p) && !LATE_STARTERS.includes(p) && p.id !== me).sort(() => Math.random() - 0.5)
  await walkIn(a, room)
  await walkIn(b, room)
  await postInRoom(room, a, 'Shall we go through the plan for next week?')
  await postInRoom(room, b, 'Yes. I have the numbers here.')
  return { room, person: a }
}

/** Someone in a room asks the person in this window to come in, by the same route a person's would. */
export async function inviteMe(me: string) {
  const { room, person } = await aRoomInUse(me)
  const id = await rpc(person, 'invite_to_room', { p_to: me })
  await fetch('/api/office/room-invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fakeJwt({ sub: person.id, email: person.email, role: 'authenticated' })}` },
    body: JSON.stringify({ inviteId: id }),
  })
  return { from: person.name, room }
}

/** Whoever is talking in a room carries on, so a person stepping in finds a live conversation. */
async function aRoomTalks() {
  const rows = await asOwner(async (tx) => (await tx.query<{ user_id: string; room_id: string }>(`select user_id, room_id from public.office_room_occupants`)).rows)
  const speakers = rows.filter((r) => rows.filter((x) => x.room_id === r.room_id).length > 1).map((r) => ({ room: r.room_id, person: byId(r.user_id) })).filter((r): r is { room: string; person: Person } => !!r.person && free(r.person))
  if (!speakers.length) return false
  const s = pick(speakers)
  await postInRoom(s.room, s.person, pick(ROOM.chatter))
  return true
}

function asOwnerChat(knockId: string, p: Person, body: string) {
  return asOwner((tx) => tx.query(`insert into public.office_chat_messages (knock_id, sender, body) values ($1, $2, $3)`, [knockId, p.id, body]))
}

function post(channel: string, p: Person, body: string) {
  return asOwner((tx) => tx.query(`insert into public.office_channel_messages (channel, sender, body, created_at) values ($1, $2, $3, demo.now())`, [channel, p.id, body]))
}

/** One small thing somebody does, every half minute or so. */
async function somethingHappens() {
  const roll = Math.random()
  const inOffice = await asOwner(async (tx) => (await tx.query<{ user_id: string }>(`select user_id from public.office_reports where work_date = $1 and kind = 'signin'`, [lagosDay()])).rows)
  const team = inOffice.map((r) => byId(r.user_id)).filter((p): p is Person => !!p && free(p))
  if (!team.length) return
  const p = pick(team)
  if (roll < 0.3) {
    await rpc(p, 'set_office_status', { p_working_on: pick(WORK[p.beat].doing), p_back_at: null, p_out_until: null })
  } else if (roll < 0.5) {
    const ch = pick(['general', 'wins', 'help'] as const)
    await post(ch, p, pick(CHAT.channel[ch]))
  } else if (roll < 0.75) {
    if (!(await aRoomTalks())) await moveATask(team)
  } else {
    await moveATask(team)
  }
}

async function moveATask(team: Person[]) {
  const ids = team.map((p) => p.id)
  const t = await asOwner(async (tx) => (await tx.query<{ id: string; assigned_to: string; assigned_by: string; status: string }>(
    `select id, assigned_to, assigned_by, status from public.office_tasks
      where status in ('open', 'in_progress', 'done') and assigned_to <> assigned_by
        and (assigned_to = any($1::uuid[]) or (status = 'done' and assigned_by = any($1::uuid[])))
      order by random() limit 1`, [ids])).rows[0])
  if (!t) return
  const doer = byId(t.assigned_to)
  const giver = byId(t.assigned_by)
  if (t.status === 'open' && doer && free(doer)) await rpc(doer, 'start_task', { p_id: t.id })
  if (t.status === 'in_progress' && doer && free(doer)) {
    await rpc(doer, 'complete_task', { p_id: t.id, p_note: 'All done, please take a look.' })
    await tellRoute(doer, t.id)
  }
  // Tunde's and Ngozi's own reviews are left for the presenter to show, unless nobody is being them.
  if (t.status === 'done' && giver && free(giver) && !humansPresent().size) await rpc(giver, 'review_task', { p_id: t.id, p_approve: true })
}

/** Someone knocks on the person in this window, on request or now and then. */
export async function knockOn(me: string, from?: Person) {
  const team = await asOwner(async (tx) => (await tx.query<{ user_id: string }>(`select user_id from public.office_reports where work_date = $1 and kind = 'signin'`, [lagosDay()])).rows)
  const candidates = [NGOZI, ...team.map((r) => byId(r.user_id))].filter((p): p is Person => !!p && p.id !== me && free(p))
  const knocker = from ?? pick(candidates.length ? candidates : PEOPLE.filter((p) => p.id !== me && free(p)))
  await rpc(knocker, 'knock', { p_to: me })
  return knocker.name
}

/** A task lands on the person in this window. */
export async function giveTask(me: string) {
  const giver = me === NGOZI.id ? TUNDE : NGOZI
  const asker = free(giver) ? giver : [TUNDE, BISI].find(free) ?? IFE
  const id = await rpc(asker, 'create_task', { p_to: me, p_title: pick(['Check the Q4 budget draft', 'Review the customer webinar slides', 'Send me next week’s plan']), p_details: 'When you have a moment today, please.', p_due: lagosDay() })
  await tellRoute(asker, String(id))
  return asker.name
}

let started = false

export function startSimulation() {
  if (started || !('locks' in navigator)) return
  started = true
  void navigator.locks.request('office-demo-team', () => new Promise<void>(() => {
    subscribeBus((m) => {
      if (m.t === 'changes') m.rows.forEach(onChange)
    })
    void syncPresence().catch(() => undefined)
    void runClockJobs().catch(() => undefined)
    setInterval(() => void syncPresence().catch(() => undefined), 60_000)
    setInterval(() => void runClockJobs().catch(() => undefined), 60_000)
    const again = () =>
      setTimeout(() => {
        void somethingHappens().catch((e: unknown) => console.warn('demo team:', e)).finally(again)
      }, 25_000 + Math.random() * 25_000)
    again()
  }))
}

