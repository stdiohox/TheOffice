import { asOwner } from '../engine'

/** The Resend SDK, for the demo: every email lands in the outbox page instead of an inbox. */
export class Resend {
  constructor(_key?: string) {}

  emails = {
    send: async (m: { from: string; to: string | string[]; subject: string; html: string; text?: string }) => {
      const to = Array.isArray(m.to) ? m.to.join(', ') : m.to
      await asOwner((tx) =>
        tx.query(`insert into demo.outbox (from_addr, to_addr, subject, html, body_text) values ($1, $2, $3, $4, $5)`, [
          m.from,
          to,
          m.subject,
          m.html,
          m.text ?? '',
        ]),
      )
      return { data: { id: crypto.randomUUID() }, error: null as { message: string } | null }
    },
  }
}
