import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail } from 'lucide-react'
import { EmptyState, Skeleton } from '@/components/ui/primitives'
import { useOfficeSettings } from '@/hooks/useOffice'
import { asOwner } from '@/demo/engine'
import { subscribeBus } from '@/demo/bus'
import { localParts } from '@/lib/timezones'
import { cn } from '@/lib/utils'

/**
 * Demo only: nothing leaves the browser, so every email the office would have sent
 * lands here, written by the real templates. Invite links in them really work.
 */
interface Row {
  id: number
  sent_at: string
  to_addr: string
  subject: string
  html: string
}

const rows = () => asOwner(async (tx) => (await tx.query<Row>(`select id, sent_at::text, to_addr, subject, html from demo.outbox order by id desc limit 200`)).rows)

export function EmailLog() {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['demo', 'outbox'], queryFn: rows, refetchInterval: 5000 })
  const { data: settings } = useOfficeSettings()
  const [picked, setPicked] = useState<number | null>(null)
  const zone = settings?.timezone ?? 'Africa/Lagos'
  useEffect(() => subscribeBus((m) => void (m.t === 'clock' && queryClient.invalidateQueries({ queryKey: ['demo', 'outbox'] }))), [queryClient])
  const shown = data?.find((r) => r.id === picked) ?? data?.[0]
  const when = (iso: string) => {
    const d = new Date(iso.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'))
    const p = localParts(zone, d)
    return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: zone })}, ${p.time}`
  }

  return (
    <div className="office-page">
      <div className="hairline-b sticky top-[var(--app-sticky-top)] z-10 bg-surface/95 px-4 pt-4 pb-3 backdrop-blur-sm sm:px-6">
        <h1 className="font-display text-[28px] leading-none font-medium text-text-primary">Email log</h1>
        <p className="mt-1.5 text-[13px] text-text-muted">
          Every email the office sends, as it would arrive. In this demo they stop here and never reach an inbox.
        </p>
      </div>
      <div className="mx-auto grid max-w-[1200px] gap-4 p-4 sm:p-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        {isLoading ? <Skeleton className="h-80" /> : null}
        {!isLoading && !data?.length ? (
          <div className="lg:col-span-2">
          <EmptyState icon={<Mail size={22} strokeWidth={1.5} />} title="No emails yet" body="Knock on someone who is out, give a task or invite someone, and it appears here." />
          </div>
        ) : null}
        {data?.length ? (
          <>
            <ul className="space-y-1.5 lg:max-h-[calc(100dvh-13rem)] lg:overflow-y-auto">
              {data.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    aria-current={shown?.id === r.id || undefined}
                    onClick={() => setPicked(r.id)}
                    className={cn(
                      'press hairline w-full rounded-[14px] bg-surface-raised p-3 text-left transition-colors duration-150 hover:bg-surface-sunken',
                      shown?.id === r.id && 'ring-2 ring-forest',
                    )}
                  >
                    <p className="truncate text-[14px] font-semibold text-text-primary">{r.subject}</p>
                    <p className="truncate text-[12px] text-text-muted">
                      To {r.to_addr}, {when(r.sent_at)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
            {shown ? (
              <iframe title={`Email: ${shown.subject}`} srcDoc={shown.html.replace('<head>', '<head><base target="_blank">')} sandbox="allow-popups allow-popups-to-escape-sandbox" className="hairline h-[70dvh] w-full rounded-[14px] bg-white lg:h-[calc(100dvh-13rem)]" />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
}
