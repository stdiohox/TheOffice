import { publish, type Change } from './bus'

/**
 * The database connection, and the one way in: a transaction as someone. Exactly
 * what PostgREST does per request (role plus JWT claims), so the migrations' own
 * row-level security decides what each person can read and write.
 */
export interface Who {
  role: 'anon' | 'authenticated' | 'service_role'
  sub?: string
}

export interface Tx {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
  exec(sql: string): Promise<unknown>
}

interface Reply {
  id: number
  result?: unknown
  error?: { message: string; code?: string; detail?: string; hint?: string }
}

type Port = { postMessage: (m: unknown) => void; onmessage: ((e: MessageEvent<Reply>) => void) | null }

let port: Port | null = null
let nextId = 0
/** This page load: a reload is a new client, even in the same window. */
const client = crypto.randomUUID()
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()

function connect(): Port {
  if (port) return port
  // A phone browser without SharedWorker still gets the demo, in one tab. Each URL is
  // written in place: Vite only bundles a worker it can see in the constructor.
  if ('SharedWorker' in window) {
    const shared = new SharedWorker(new URL('./db.worker.ts', import.meta.url), { type: 'module', name: 'office-demo-db' })
    port = shared.port
    shared.port.start()
  } else {
    port = new Worker(new URL('./db.worker.ts', import.meta.url), { type: 'module' })
  }
  window.addEventListener('pagehide', () => port?.postMessage({ op: 'bye', client }))
  port.onmessage = (e) => {
    const waiter = pending.get(e.data.id)
    if (!waiter) return
    pending.delete(e.data.id)
    if (e.data.error) waiter.reject(Object.assign(new Error(e.data.error.message), e.data.error))
    else waiter.resolve(e.data.result)
  }
  return port
}

function call<T>(message: Record<string, unknown>): Promise<T> {
  const id = ++nextId
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    connect().postMessage({ id, ...message })
  })
}

/** Writes reach IndexedDB a moment after they commit; this waits for them. */
export const syncDb = () => call<void>({ op: 'sync' })

async function inTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = crypto.randomUUID()
  await call({ op: 'begin', tx, client })
  const handle: Tx = {
    query: <R,>(sql: string, params?: unknown[]) => call<{ rows: R[] }>({ op: 'query', tx, sql, params }),
    exec: (sql: string) => call({ op: 'exec', tx, sql }),
  }
  try {
    const out = await fn(handle)
    await call({ op: 'commit', tx })
    return out
  } catch (e) {
    await call({ op: 'rollback', tx }).catch(() => undefined)
    throw e
  }
}

export async function asRole<T>(who: Who, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { result, changes } = await inTransaction(async (tx) => {
    await tx.exec(`select set_config('request.jwt.claim.sub', ${lit(who.sub ?? '')}, true), set_config('request.jwt.claim.role', ${lit(who.role)}, true); set local role ${who.role}`)
    const result = await fn(tx)
    await tx.exec('reset role')
    const changes = await drainChanges(tx)
    return { result, changes }
  })
  if (changes.length) publish({ t: 'changes', rows: changes })
  return result
}

/** As the database owner: no role, no rules. For the seed, the clock and the demo's own tables. */
export async function asOwner<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { result, changes } = await inTransaction(async (tx) => {
    const result = await fn(tx)
    const changes = await drainChanges(tx)
    return { result, changes }
  })
  if (changes.length) publish({ t: 'changes', rows: changes })
  return result
}

async function drainChanges(tx: Tx): Promise<Change[]> {
  const r = await tx.query<{ j: Change[] | null }>(
    `with d as (delete from demo.changes returning *)
     select json_agg(json_build_object('tbl', tbl, 'op', op, 'new', new, 'old', old) order by id) j from d`,
  )
  return r.rows[0]?.j ?? []
}

export const lit = (v: string) => `'${v.replace(/'/g, "''")}'`
export const ident = (v: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(v)) throw Object.assign(new Error(`Bad identifier: ${v}`), { code: '42703' })
  return `"${v}"`
}
