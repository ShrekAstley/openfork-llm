// When one brain nation thinks: every `intervalTicks` of simulated time, or
// early on a HIGH/CRITICAL event. LOW/MEDIUM events only ride along in the
// next periodic observation. Pure: driven by ticks, no clock.
export enum Importance {
  LOW = 0,
  MEDIUM = 1,
  HIGH = 2,
  CRITICAL = 3,
}

export class DecisionScheduler {
  private next = 0;
  private pending: Importance | null = null;
  /** Consecutive periodic wakes that had nothing to react to. */
  private quiet = 0;

  /**
   * `backoffMax`: a quiet empire waits up to this many intervals between
   * periodic decisions (1 = fixed). Any event brings it back to one.
   */
  constructor(
    private intervalTicks: number,
    private backoffMax = 1,
  ) {}

  snapshot(): { next: number; pending: number | null; quiet: number } {
    return { next: this.next, pending: this.pending, quiet: this.quiet };
  }

  restore(s: { next: number; pending: number | null; quiet?: number }): void {
    this.next = s.next;
    this.pending = s.pending;
    this.quiet = s.quiet ?? 0;
  }

  notify(i: Importance): void {
    this.pending = Math.max(this.pending ?? i, i);
  }

  /**
   * The importance to wake with at `tick`, or null to stay asleep. Waking
   * consumes the pending trigger and restarts the period.
   */
  poll(tick: number, busy: boolean): Importance | null {
    if (busy) return null;
    const early = this.pending !== null && this.pending >= Importance.HIGH;
    if (!early && tick < this.next) return null;
    const wake = this.pending ?? Importance.LOW;
    this.quiet =
      this.pending === null ? Math.min(this.quiet + 1, this.backoffMax - 1) : 0;
    this.pending = null;
    this.next = tick + this.intervalTicks * (1 + this.quiet);
    return wake;
  }
}
