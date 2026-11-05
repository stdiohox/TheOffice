import { createClient } from '@supabase/supabase-js'
import { tabId } from './bus'
import { ANON_KEY, SERVICE_KEY, authRequest, whoFromToken } from './auth'
import { DemoChannel } from './realtime'
import { restRequest } from './rest'
import { demoStorage } from './storage'

/**
 * Where the office's network calls go in the demo. The app keeps using the real
 * @supabase/supabase-js; only its fetch, its channels and its storage are swapped,
 * so the screens and hooks are the ones the live office runs.
 */
export const DEMO_URL = 'https://brightwork.demo.invalid'

async function demoFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : null
  const url = new URL(req ? req.url : String(input))
  const method = init?.method ?? req?.method ?? 'GET'
  const headers = new Headers(init?.headers ?? req?.headers)
  const body = typeof init?.body === 'string' ? init.body : req ? await req.text() : null
  if (url.pathname.startsWith('/rest/v1/')) {
    const who = whoFromToken((headers.get('authorization') ?? '').replace(/^Bearer /, ''))
    return restRequest({ role: who.role, sub: who.sub }, url, method, headers, body)
  }
  if (url.pathname.startsWith('/auth/v1/')) return authRequest(url, method, headers, body)
  return new Response(JSON.stringify({ message: `Not in the demo: ${url.pathname}` }), { status: 404 })
}

/** The browser's client, one session per window so two windows can be two people. */
export function createDemoClient() {
  const client = createClient(DEMO_URL, ANON_KEY, {
    global: { fetch: demoFetch },
    auth: {
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: sessionStorage,
      storageKey: `office-demo-auth-${tabId}`,
    },
  })
  const who = async () => {
    const { data } = await client.auth.getSession()
    const w = whoFromToken(data.session?.access_token)
    return { role: w.role, sub: w.sub }
  }
  const c = client as unknown as Record<string, unknown>
  c.channel = (topic: string, opts?: { config?: { presence?: { key?: string } } }) => new DemoChannel(topic, opts)
  c.removeChannel = (channel: DemoChannel) => channel.unsubscribe()
  Object.defineProperty(client, 'storage', { value: demoStorage(who) })
  // For scripts/demo/e2e: asks the database what a person may do, in a built app too.
  ;(window as unknown as { __supabase: unknown }).__supabase = client
  return client
}

/** The service-role client the routes use. */
export function createServiceClient() {
  return createClient(DEMO_URL, SERVICE_KEY, {
    global: { fetch: demoFetch },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'office-demo-service' },
  })
}

/** /api/* in the browser: the real route files, run here. */
export function installApiFetch() {
  const real = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(href, location.origin)
    if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
      // Loaded on the first call: the routes are not needed to open the office.
      const { handleRoute } = await import('./routes')
      return handleRoute(url, init)
    }
    return real(input, init)
  }
}
