import { subscribeBus, publish, tabId, type Change } from './bus'

/**
 * Supabase Realtime, as far as the office asks of it: table changes and the
 * office's presence channel, carried between windows by the bus. Changes come from
 * triggers in the database (demo.changes), so nothing has to remember to announce.
 */
type Payload = Record<string, unknown>
/** person -> source (a window, or the simulated team) -> what they track */
const presence = new Map<string, Map<string, Payload>>()
const syncListeners = new Set<() => void>()

function applyPresence(source: string, key: string, payload: Payload | null) {
  const of = presence.get(key) ?? new Map<string, Payload>()
  if (payload) of.set(source, payload)
  else of.delete(source)
  if (of.size) presence.set(key, of)
  else presence.delete(key)
  syncListeners.forEach((l) => l())
}

/** What this window tracks, to answer the next window that opens. */
const mine = new Map<string, Payload>()

export function setPresence(source: string, key: string, payload: Payload | null) {
  publish({ t: 'presence', source, key, payload })
}

/** The simulated team, held by the window that plays them, to answer a new window. */
const simulated = new Map<string, Payload>()

export function setSimPresence(key: string, payload: Payload | null) {
  if (payload) simulated.set(key, payload)
  else simulated.delete(key)
  setPresence('sim', key, payload)
}

const SEAT = 'seat:'
let mySeat: string | null = null

/** This window is being someone. The simulation leaves that person alone. */
export function claimSeat(userId: string | null) {
  if (mySeat === userId) return
  if (mySeat) {
    mine.delete(SEAT + mySeat)
    setPresence(tabId, SEAT + mySeat, null)
  }
  mySeat = userId
  if (userId) {
    mine.set(SEAT + userId, {})
    setPresence(tabId, SEAT + userId, {})
  }
}

/** Everyone a person is being right now, in any window. */
export function humansPresent(): Set<string> {
  const out = new Set<string>()
  for (const key of presence.keys()) if (key.startsWith(SEAT)) out.add(key.slice(SEAT.length))
  return out
}

/** Ask the other windows who they are. */
export const helloPresence = () => publish({ t: 'presence-hello' })

subscribeBus((m) => {
  if (m.t === 'presence') applyPresence(m.source, m.key, m.payload)
  if (m.t === 'presence-hello') {
    for (const [key, payload] of mine) setPresence(tabId, key, payload)
    for (const [key, payload] of simulated) setPresence('sim', key, payload)
  }
})

window.addEventListener('pagehide', () => {
  for (const key of mine.keys()) setPresence(tabId, key, null)
})

type Listener =
  | { kind: 'presence'; cb: () => void }
  | { kind: 'changes'; event: string; table: string; filter?: { column: string; value: string }; cb: (p: unknown) => void }

function matches(l: Extract<Listener, { kind: 'changes' }>, c: Change) {
  if (l.table !== c.tbl) return false
  if (l.event !== '*' && l.event !== c.op) return false
  if (!l.filter) return true
  const row = c.new ?? c.old
  return String(row?.[l.filter.column]) === l.filter.value
}

export class DemoChannel {
  state: 'closed' | 'joined' = 'closed'
  private listeners: Listener[] = []
  private off: (() => void) | null = null
  private syncing: (() => void) | null = null
  private key: string
  readonly topic: string

  constructor(topic: string, opts?: { config?: { presence?: { key?: string } } }) {
    this.topic = topic
    this.key = opts?.config?.presence?.key ?? ''
  }

  on(type: 'presence' | 'postgres_changes', spec: { event?: string; table?: string; filter?: string }, cb: (p: unknown) => void) {
    if (type === 'presence') this.listeners.push({ kind: 'presence', cb: cb as () => void })
    else {
      const f = spec.filter?.match(/^(\w+)=eq\.(.+)$/)
      this.listeners.push({
        kind: 'changes',
        event: spec.event ?? '*',
        table: spec.table ?? '',
        filter: f ? { column: f[1], value: f[2] } : undefined,
        cb,
      })
    }
    return this
  }

  subscribe(cb?: (status: string, err?: Error) => void) {
    this.state = 'joined'
    this.off = subscribeBus((m) => {
      if (m.t !== 'changes') return
      for (const l of this.listeners) {
        if (l.kind !== 'changes') continue
        for (const c of m.rows) {
          if (matches(l, c)) l.cb({ eventType: c.op, new: c.new ?? {}, old: c.old ?? {}, schema: 'public', table: c.tbl })
        }
      }
    })
    if (this.listeners.some((l) => l.kind === 'presence')) {
      this.syncing = () => this.listeners.forEach((l) => l.kind === 'presence' && l.cb())
      syncListeners.add(this.syncing)
      publish({ t: 'presence-hello' })
    }
    queueMicrotask(() => cb?.('SUBSCRIBED'))
    return this
  }

  async track(payload: Payload) {
    mine.set(this.key, payload)
    setPresence(tabId, this.key, payload)
    return 'ok'
  }

  async untrack() {
    mine.delete(this.key)
    setPresence(tabId, this.key, null)
    return 'ok'
  }

  presenceState<T>(): Record<string, T[]> {
    const out: Record<string, T[]> = {}
    for (const [key, of] of presence) if (!key.startsWith(SEAT)) out[key] = [...of.values()] as T[]
    return out
  }

  async unsubscribe() {
    this.state = 'closed'
    this.off?.()
    this.off = null
    if (this.syncing) syncListeners.delete(this.syncing)
    this.syncing = null
    if (this.key && mine.has(this.key)) await this.untrack()
    return 'ok'
  }
}
