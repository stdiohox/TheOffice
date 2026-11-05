import { asOwner, lit } from './engine'
import type { Who } from './engine'

/**
 * Supabase Auth, as far as the office asks of it, from auth.users in the same
 * database. Passwords sit in plain text: every login here is sample data. The
 * invite and recovery links still work: one-time tokens in demo.tokens, the trigger
 * in 0001 makes the profile on confirmation.
 */
export const CRON_SECRET = 'demo-cron-secret-0123456789abcdef0123'
export const SERVICE_KEY = fakeJwt({ role: 'service_role' })
export const ANON_KEY = fakeJwt({ role: 'anon' })

export function fakeJwt(claims: Record<string, unknown>) {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  // Real time, not the demo clock: long enough that moving the clock cannot expire it.
  const exp = Math.floor(performance.timeOrigin / 1000) + 3600 * 24 * 400
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ aud: 'authenticated', exp, ...claims })}.demo`
}

export function whoFromToken(token: string | null | undefined): Who & { email?: string } {
  if (!token) return { role: 'anon' }
  try {
    const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { role?: Who['role']; sub?: string; email?: string }
    return { role: claims.role ?? 'anon', sub: claims.sub, email: claims.email }
  } catch {
    return { role: 'anon' }
  }
}

interface UserRow {
  id: string
  email: string
  encrypted_password: string | null
  email_confirmed_at: string | null
  created_at: string
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const fail = (status: number, code: string, message: string) => json(status, { code: status, error_code: code, msg: message, message })

const userJson = (u: UserRow) => ({
  id: u.id,
  aud: 'authenticated',
  role: 'authenticated',
  email: u.email,
  email_confirmed_at: u.email_confirmed_at,
  created_at: u.created_at,
  updated_at: u.created_at,
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  identities: [],
})

function session(u: UserRow) {
  const access = fakeJwt({ sub: u.id, email: u.email, role: 'authenticated', session_id: crypto.randomUUID() })
  const expiresIn = 3600 * 24 * 300
  return {
    access_token: access,
    refresh_token: access,
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    user: userJson(u),
  }
}

const COLS = `id, email, encrypted_password, email_confirmed_at, created_at`

async function findByEmail(email: string) {
  return asOwner(async (tx) => (await tx.query<UserRow>(`select ${COLS} from auth.users where lower(email) = lower($1)`, [email])).rows[0] ?? null)
}

async function findById(id: string) {
  return asOwner(async (tx) => (await tx.query<UserRow>(`select ${COLS} from auth.users where id = $1`, [id])).rows[0] ?? null)
}

export async function authRequest(url: URL, method: string, headers: Headers, body: string | null): Promise<Response> {
  const path = url.pathname.split('/auth/v1')[1]
  const input = body ? (JSON.parse(body) as Record<string, string>) : {}
  const token = (headers.get('authorization') ?? '').replace(/^Bearer /, '')
  const who = whoFromToken(token)

  if (path === '/token') {
    const grant = url.searchParams.get('grant_type')
    if (grant === 'password') {
      const u = await findByEmail(input.email ?? '')
      if (!u || u.encrypted_password !== input.password || !u.email_confirmed_at) {
        return fail(400, 'invalid_credentials', 'Invalid login credentials')
      }
      return json(200, session(u))
    }
    if (grant === 'refresh_token') {
      const sub = whoFromToken(input.refresh_token).sub
      const u = sub ? await findById(sub) : null
      return u ? json(200, session(u)) : fail(400, 'refresh_token_not_found', 'Invalid Refresh Token')
    }
  }

  if (path === '/logout') return new Response(null, { status: 204 })

  if (path === '/user') {
    if (!who.sub) return fail(401, 'bad_jwt', 'invalid JWT')
    const u = await findById(who.sub)
    if (!u) return fail(404, 'user_not_found', 'User not found')
    if (method === 'PUT' && input.password) {
      await asOwner((tx) => tx.query(`update auth.users set encrypted_password = $1 where id = $2`, [input.password, u.id]))
    }
    return json(200, userJson(u))
  }

  if (path === '/verify') {
    const row = await asOwner(async (tx) => {
      const t = (await tx.query<{ email: string }>(`delete from demo.tokens where token_hash = $1 returning email`, [input.token_hash])).rows[0]
      if (!t) return null
      await tx.query(`update auth.users set email_confirmed_at = coalesce(email_confirmed_at, demo.now()) where lower(email) = lower($1)`, [t.email])
      return t
    })
    if (!row) return fail(403, 'otp_expired', 'Email link is invalid or has expired')
    const u = await findByEmail(row.email)
    return u ? json(200, session(u)) : fail(404, 'user_not_found', 'User not found')
  }

  if (path.startsWith('/admin/')) {
    if (who.role !== 'service_role') return fail(403, 'not_admin', 'User not allowed')

    if (path === '/admin/generate_link') {
      const email = (input.email ?? '').toLowerCase()
      let u = await findByEmail(email)
      if (input.type === 'invite') {
        if (u) return fail(422, 'email_exists', 'A user with this email address has already been registered')
        u = await asOwner(async (tx) => (await tx.query<UserRow>(`insert into auth.users (email) values ($1) returning ${COLS}`, [email])).rows[0])
      }
      if (!u) return fail(404, 'user_not_found', 'User not found')
      const hashed = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
      const type = input.type === 'recovery' ? 'recovery' : input.type === 'magiclink' ? 'magiclink' : 'invite'
      await asOwner((tx) => tx.query(`insert into demo.tokens (token_hash, email, type) values ($1, $2, $3)`, [hashed, email, type]))
      return json(200, { ...userJson(u), action_link: '', email_otp: '', hashed_token: hashed, redirect_to: '', verification_type: type })
    }

    if (path === '/admin/users' && method === 'GET') {
      const rows = await asOwner(async (tx) => (await tx.query<UserRow>(`select ${COLS} from auth.users`)).rows)
      return json(200, { users: rows.map(userJson), aud: 'authenticated' })
    }

    const m = path.match(/^\/admin\/users\/([0-9a-f-]+)$/)
    if (m) {
      if (method === 'PUT' && input.password) {
        await asOwner((tx) => tx.query(`update auth.users set encrypted_password = $1 where id = $2`, [input.password, m[1]]))
      }
      if (method === 'DELETE') await asOwner((tx) => tx.query(`delete from auth.users where id = ${lit(m[1])}`))
      const u = await findById(m[1])
      return u ? json(200, userJson(u)) : method === 'DELETE' ? json(200, {}) : fail(404, 'user_not_found', 'User not found')
    }
  }

  return fail(404, 'not_found', `Not in the demo: ${method} ${path}`)
}
