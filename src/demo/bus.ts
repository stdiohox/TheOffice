/** What every open window of the demo tells the others. Also delivered to this window. */
export interface Change {
  tbl: string
  op: 'INSERT' | 'UPDATE' | 'DELETE'
  new: Record<string, unknown> | null
  old: Record<string, unknown> | null
}

export type BusMessage =
  | { t: 'changes'; rows: Change[] }
  | { t: 'presence'; source: string; key: string; payload: Record<string, unknown> | null }
  | { t: 'presence-hello' }
  | { t: 'clock'; offset: number }
  | { t: 'reset' }

type Listener = (m: BusMessage) => void

const listeners = new Set<Listener>()
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('office-demo') : null
if (channel) channel.onmessage = (e: MessageEvent<BusMessage>) => listeners.forEach((l) => l(e.data))

export function publish(m: BusMessage) {
  listeners.forEach((l) => l(m))
  channel?.postMessage(m)
}

export function subscribeBus(l: Listener) {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/** One id per window, kept through reloads. */
export const tabId: string = (() => {
  try {
    const have = sessionStorage.getItem('office-demo-tab')
    if (have) return have
    const id = crypto.randomUUID()
    sessionStorage.setItem('office-demo-tab', id)
    return id
  } catch {
    return crypto.randomUUID()
  }
})()
