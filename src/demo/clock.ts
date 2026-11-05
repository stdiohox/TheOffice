/**
 * The demo's clock. Imported first in main.tsx, before anything reads the time.
 * The office locks its reports to set hours, so a presentation at 9pm would show
 * a closed office: the presenter moves this instead. Date here and demo.now() in
 * the database (scripts/demo/stubs.sql) carry the same offset.
 */
const KEY = 'office-demo-clock-offset'
const RealDate = Date

function read(): number {
  try {
    return Number(localStorage.getItem(KEY)) || 0
  } catch {
    return 0
  }
}

let offset = read()

class DemoDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + offset)
    else super(...(args as [string]))
  }
  static override now() {
    return RealDate.now() + offset
  }
}
// Date() without new returns a string; a bare class would throw.
globalThis.Date = new Proxy(DemoDate, { apply: () => new DemoDate().toString() }) as unknown as DateConstructor

/** Fired on window when the presenter moves the clock, so useNow redraws at once. */
export const CLOCK_MOVED = 'office-demo-clock-moved'

export const realNow = () => RealDate.now()
export const clockOffset = () => offset

export function setClockOffset(ms: number) {
  offset = ms
  try {
    localStorage.setItem(KEY, String(ms))
  } catch {
    // Private mode: the offset lasts for this tab.
  }
}
