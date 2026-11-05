import type { VercelRequest, VercelResponse } from '@vercel/node'
import recover from '../../server/auth/recover'
import officeAlerts from '../../server/cron/office-alerts'
import knockPing from '../../server/office/knock-ping'
import roomInvite from '../../server/office/room-invite'
import taskNotify from '../../server/office/task-notify'
import invite from '../../server/team/invite'

/** The route files, unchanged in their logic, called the way Vercel would. */
type Handler = (req: VercelRequest, res: VercelResponse) => unknown

const ROUTES: Record<string, Handler> = {
  '/api/auth/recover': recover,
  '/api/cron/office-alerts': officeAlerts,
  '/api/office/knock-ping': knockPing,
  '/api/office/room-invite': roomInvite,
  '/api/office/task-notify': taskNotify,
  '/api/team/invite': invite,
}

export async function handleRoute(url: URL, init?: RequestInit): Promise<Response> {
  const route = ROUTES[url.pathname]
  if (!route) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
  const headers: Record<string, string> = {}
  new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
  const text = typeof init?.body === 'string' ? init.body : ''
  let body: unknown = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = text
  }
  let status = 200
  let payload: unknown = null
  const res = {
    status(s: number) {
      status = s
      return res
    },
    json(p: unknown) {
      payload = p
      return res
    },
    end() {
      return res
    },
    setHeader() {
      return res
    },
  }
  const req = { method: init?.method ?? 'GET', headers, body, query: Object.fromEntries(url.searchParams) }
  await route(req as unknown as VercelRequest, res as unknown as VercelResponse)
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}
