export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Hard cap on simultaneous sockets. A freed slot is handed straight to the next
 * waiter rather than released and re-contended for, so the cap cannot overshoot.
 */
class Gate {
  private held = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly ceiling: number) {}

  async enter(): Promise<void> {
    if (this.held < this.ceiling) {
      this.held++;
      return;
    }
    await new Promise<void>((go) => this.waiting.push(go));
  }

  leave(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.held--;
  }
}

/**
 * Outbound pacing, so one chatty agent never hammers a merchant's shared host.
 *
 * Implemented as a virtual-scheduling (GCRA) clock rather than a refilling token
 * bucket: we track the theoretical arrival time of the next request and allow it
 * to run `burst - 1` intervals ahead of real time. That gives a clean initial
 * burst followed by exact spacing, with one number of state and no timer drift.
 */
export class Throttle {
  private arrivalClock = 0;
  private heldUntil = 0;
  private readonly interval: number;
  private readonly tolerance: number;
  private readonly gate: Gate;

  constructor(perSecond: number, burst: number, concurrency: number) {
    this.interval = 1000 / perSecond;
    this.tolerance = Math.max(0, burst - 1) * this.interval;
    this.gate = new Gate(Math.max(1, Math.floor(concurrency)));
  }

  /**
   * The store said "slow down". Everything queued backs off, not just the one
   * caller that happened to collect the 429.
   */
  holdFor(ms: number): void {
    this.heldUntil = Math.max(this.heldUntil, Date.now() + ms);
  }

  async submit<T>(job: () => Promise<T>): Promise<T> {
    await this.gate.enter();
    try {
      await this.claimSlot();
      return await job();
    } finally {
      this.gate.leave();
    }
  }

  private async claimSlot(): Promise<void> {
    for (;;) {
      const now = Date.now();

      const stillHeld = this.heldUntil - now;
      if (stillHeld > 0) {
        await sleep(stillHeld);
        continue;
      }

      const arrival = Math.max(this.arrivalClock, now);
      const earliest = arrival - this.tolerance;
      if (earliest <= now) {
        this.arrivalClock = arrival + this.interval;
        return;
      }
      await sleep(earliest - now);
    }
  }
}
