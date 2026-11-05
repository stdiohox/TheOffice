/** The sample team. Fictional people at a fictional company. */
export interface Person {
  id: string
  name: string
  email: string
  title: string
  role: 'manager' | 'hr' | 'member'
  /** What they do, for the sample reports and tasks. */
  beat: Beat
}

export type Beat = 'lead' | 'ops' | 'hr' | 'growth' | 'support' | 'sales' | 'design' | 'finance' | 'eng'

const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const p = (n: number, name: string, title: string, role: Person['role'], beat: Beat): Person => ({
  id: id(n),
  name,
  email: `${name.split(' ')[0].toLowerCase()}@brightwork.example`,
  title,
  role,
  beat,
})

export const PEOPLE: Person[] = [
  p(1, 'Ngozi Adeleke', 'Chief Executive', 'manager', 'lead'),
  p(2, 'Tunde Balogun', 'Operations Manager', 'manager', 'ops'),
  p(3, 'Bisi Ojo', 'Head of People', 'hr', 'hr'),
  p(4, 'Amaka Eze', 'Growth Lead', 'member', 'growth'),
  p(5, 'Segun Bakare', 'Customer Support', 'member', 'support'),
  p(6, 'Ifeoluwa Adeyemi', 'Sales Executive', 'member', 'sales'),
  p(7, 'Kemi Okafor', 'Product Designer', 'member', 'design'),
  p(8, 'Dayo Salami', 'Finance Officer', 'member', 'finance'),
  p(9, 'Chinedu Obi', 'Operations Associate', 'member', 'ops'),
  p(10, 'Zainab Musa', 'Software Engineer', 'member', 'eng'),
]

export const [NGOZI, TUNDE, BISI, AMAKA, SEGUN, IFE, KEMI, DAYO, CHINEDU, ZAINAB] = PEOPLE

/** Not in yet on the morning the story opens: Amaka so the presenter can sign in, Chinedu to raise the missed flag. */
export const LATE_STARTERS = [AMAKA, CHINEDU]

export const PASSWORD = 'demo1234'

/** Who the presenter can be, and what each shows off. */
export const PERSONAS: { person: Person; blurb: string }[] = [
  { person: NGOZI, blurb: 'CEO. Sees everything, sets the rules.' },
  { person: BISI, blurb: 'HR. Sees the team, runs the people.' },
  { person: TUNDE, blurb: 'Ops manager. Runs every task, not the reports.' },
  { person: AMAKA, blurb: 'Team member. Files her day, gets the tasks.' },
]

export const WORK: Record<Beat, { doing: string[]; signin: string[]; midday: string[]; eod: string[]; tasks: string[] }> = {
  lead: { doing: ['Board pack'], signin: ['Reviewing the board pack.'], midday: ['Board pack on track.'], eod: ['Board pack sent.'], tasks: ['Review the Q4 hiring plan'] },
  ops: {
    doing: ['Vendor contract renewals', 'Weekly stock count', 'Delivery schedule for next week', 'Office licence renewal'],
    signin: ['Starting on the vendor renewals, then the stock count.', 'Delivery schedule first, then supplier calls.', 'Clearing the logistics queue this morning.'],
    midday: ['Two vendors confirmed, one still to reply.', 'Stock count is 70% through, no gaps so far.', 'Delivery schedule drafted, waiting on two addresses.'],
    eod: ['Renewals done for three vendors. The last goes out tomorrow.', 'Stock count finished and logged. Two items to reorder.', 'Schedule sent to the drivers. All routes covered.'],
    tasks: ['Renew the courier contract', 'Finish the monthly stock count', 'Plan deliveries for next week', 'Reorder packing materials', 'Update the supplier list'],
  },
  hr: {
    doing: ['Onboarding pack for new hires', 'Quarterly reviews', 'Updating the leave policy'],
    signin: ['Onboarding pack, then review scheduling.', 'Quarterly review prep this morning.'],
    midday: ['Review dates sent to all managers.', 'Onboarding pack is half rewritten.'],
    eod: ['Onboarding pack ready for sign-off.', 'All reviews scheduled for next week.'],
    tasks: ['Finish the onboarding pack', 'Schedule the quarterly reviews', 'Update the leave policy'],
  },
  growth: {
    doing: ['November newsletter', 'Referral campaign', 'Landing page copy'],
    signin: ['Newsletter draft first, then the referral numbers.', 'Writing the landing page copy this morning.', 'Campaign report, then social posts for next week.'],
    midday: ['Newsletter draft is with Kemi for images.', 'Referral campaign brought in 14 sign-ups so far.', 'Landing page copy done, moving to the ads.'],
    eod: ['Newsletter scheduled for Thursday. Next week’s posts are queued.', 'Referral report shared with the team. Conversion is up on last month.', 'Landing page is live. Ads go out tomorrow morning.'],
    tasks: ['Write the November newsletter', 'Report on the referral campaign', 'Draft next week’s social posts', 'Refresh the landing page copy', 'Plan the customer webinar'],
  },
  support: {
    doing: ['Clearing the support inbox', 'Help centre articles', 'Weekly complaints review'],
    signin: ['Working through the overnight tickets.', 'Inbox first, then two help articles.'],
    midday: ['Inbox down to 12 open tickets.', 'Three help articles updated.', 'Called back the two urgent customers.'],
    eod: ['Closed 31 tickets today, 4 still open with engineering.', 'Weekly complaints review done and shared.', 'Inbox clear. Handover note written for tomorrow.'],
    tasks: ['Update the refund help article', 'Prepare the weekly complaints review', 'Call back the priority customers', 'Write the new-customer welcome guide'],
  },
  sales: {
    doing: ['Follow-ups from Tuesday’s demos', 'Proposal for a new retail client', 'Pipeline clean-up'],
    signin: ['Follow-up calls this morning, proposal this afternoon.', 'Pipeline review, then four client calls.'],
    midday: ['Six calls done, two asked for proposals.', 'Proposal draft is with Ngozi for pricing.'],
    eod: ['Two proposals sent. One verbal yes to chase on Friday.', 'Pipeline updated. Three deals move to negotiation.', 'Closed one renewal and booked two demos for next week.'],
    tasks: ['Send the retail client proposal', 'Clean up the sales pipeline', 'Prepare the monthly sales report', 'Follow up on last week’s demos'],
  },
  design: {
    doing: ['Mobile app onboarding screens', 'Brand refresh for the newsletter', 'Pitch deck visuals'],
    signin: ['Onboarding screens, second pass.', 'Pitch deck visuals this morning.'],
    midday: ['Onboarding flow is ready for review.', 'Newsletter images handed to Amaka.'],
    eod: ['Screens handed to Zainab with notes.', 'Pitch deck finished and shared.', 'Three newsletter layouts ready to choose from.'],
    tasks: ['Design the mobile onboarding screens', 'Refresh the pitch deck', 'Create newsletter image templates', 'Redraw the pricing page'],
  },
  finance: {
    doing: ['Month-end close', 'Supplier payments run', 'VAT filing'],
    signin: ['Reconciling yesterday’s payments first.', 'Month-end close, day two.'],
    midday: ['Bank reconciliation finished, no differences.', 'Payment run approved and queued.'],
    eod: ['Supplier payments sent. Ledger balanced for the day.', 'Month-end close on track for Friday.', 'VAT schedule prepared for review.'],
    tasks: ['Complete the month-end close', 'Prepare the VAT schedule', 'Run the supplier payments', 'Reconcile the October bank statement'],
  },
  eng: {
    doing: ['Checkout bug fixes', 'Mobile app release', 'Database backups review'],
    signin: ['Finishing the checkout fix, then code review.', 'Release prep this morning.'],
    midday: ['Checkout fix is in testing.', 'Reviewed two pull requests, one needs changes.'],
    eod: ['Checkout fix is live. Error rate back to normal.', 'Release 2.4 submitted to the app stores.', 'Backups tested and restored successfully.'],
    tasks: ['Fix the checkout timeout', 'Ship mobile release 2.4', 'Test the database restore', 'Build the onboarding screens'],
  },
}
