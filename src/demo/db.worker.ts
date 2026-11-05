import { PGlite } from '@electric-sql/pglite'

declare const __DEMO_DB_VERSION__: string

/**
 * One Postgres for every window of the demo, in a SharedWorker: a window can reload
 * or close and the database carries on. Transactions come in from the windows one
 * statement at a time, one transaction at a time. A window that vanishes halfway
 * loses its transaction to the watchdog, so it can never block the others.
 */
const NAME = `office-demo-${__DEMO_DB_VERSION__}`
const IDLE_MS = 4_000

async function open() {
  const known = await indexedDB.databases()
  const exists = known.some((d) => d.name === `/pglite/${NAME}`)
  for (const d of known) {
    if (d.name?.startsWith('/pglite/office-demo-') && d.name !== `/pglite/${NAME}`) indexedDB.deleteDatabase(d.name)
  }
  let loadDataDir: Blob | undefined
  if (!exists) {
    const res = await fetch('/demo/office.tar.gz')
    if (!res.ok) throw new Error(`Could not load the office (${res.status}).`)
    loadDataDir = await res.blob()
  }
  return new PGlite({ dataDir: `idb://${NAME}`, relaxedDurability: true, loadDataDir })
}

const opening = open()

let current: string | null = null
let watchdog: ReturnType<typeof setTimeout> | null = null
/** A statement in progress: slow is not the same as gone. */
let running = 0
const waiting: { client?: string; go: () => void; drop: (e: Error) => void }[] = []
let currentClient: string | undefined

function release(tx: string) {
  if (current !== tx) return
  current = null
  currentClient = undefined
  if (watchdog) clearTimeout(watchdog)
  watchdog = null
  waiting.shift()?.go()
}

function touch(db: PGlite, tx: string) {
  if (watchdog) clearTimeout(watchdog)
  watchdog = setTimeout(() => {
    if (current !== tx) return
    if (running) return touch(db, tx)
    void db.exec('rollback').catch(() => undefined).finally(() => release(tx))
  }, IDLE_MS)
}

interface Call {
  id: number
  op: 'begin' | 'query' | 'exec' | 'commit' | 'rollback' | 'sync' | 'bye'
  client?: string
  tx?: string
  sql?: string
  params?: unknown[]
}

async function run(c: Call): Promise<unknown> {
  const db = await opening
  // db.syncToFs() would return at once under relaxedDurability; this waits for the disk.
  if (c.op === 'sync') return (db as unknown as { fs: { syncToFs: (relaxed: boolean) => Promise<void> } }).fs.syncToFs(false)
  if (c.op === 'bye') {
    // A window that reloads or closes: what it had queued would each hold everyone
    // else up until the watchdog, so a reload of a busy window took half a minute.
    for (const w of waiting.filter((x) => x.client === c.client)) {
      waiting.splice(waiting.indexOf(w), 1)
      w.drop(new Error('That window has gone.'))
    }
    if (current && currentClient === c.client) {
      const tx = current
      await db.exec('rollback').catch(() => undefined)
      release(tx)
    }
    return null
  }
  const tx = c.tx!
  if (c.op === 'begin') {
    if (current) await new Promise<void>((go, drop) => waiting.push({ client: c.client, go, drop }))
    current = tx
    currentClient = c.client
    touch(db, tx)
    return db.exec('begin')
  }
  if (current !== tx) throw new Error('That transaction has ended.')
  if (c.op === 'commit' || c.op === 'rollback') {
    try {
      await db.exec(c.op)
    } finally {
      release(tx)
    }
    return null
  }
  touch(db, tx)
  running++
  try {
    if (c.op === 'exec') {
      await db.exec(c.sql!)
      return null
    }
    const r = await db.query(c.sql!, c.params)
    return { rows: r.rows }
  } finally {
    running--
  }
}

function serve(port: { postMessage: (m: unknown) => void; onmessage: ((e: MessageEvent<Call>) => void) | null; start?: () => void }) {
  port.onmessage = (e) => {
    const c = e.data
    run(c).then(
      (result) => port.postMessage({ id: c.id, result }),
      (err: { message: string; code?: string; detail?: string; hint?: string }) =>
        port.postMessage({ id: c.id, error: { message: err.message, code: err.code, detail: err.detail, hint: err.hint } }),
    )
  }
  port.start?.()
}

const scope = globalThis as unknown as { onconnect?: unknown; postMessage: (m: unknown) => void; onmessage: ((e: MessageEvent<Call>) => void) | null }
if ('onconnect' in scope) {
  scope.onconnect = (e: MessageEvent) => serve(e.ports[0] as unknown as Parameters<typeof serve>[0])
} else {
  serve(scope)
}
