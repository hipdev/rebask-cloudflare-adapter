import { DurableObject } from "cloudflare:workers";
import { PurgeState } from "./purge-state.js";
/** A private same-Worker service binding, never an HTTP purge endpoint. */
interface PurgeEnv {
  REBASK_SELF: { purgePageCache(): Promise<void> };
}
export class RebaskPurge extends DurableObject<PurgeEnv> {
  private state: PurgeState;
  private alarmWrites = Promise.resolve();
  constructor(ctx: DurableObjectState, env: PurgeEnv) {
    super(ctx, env);
    this.state = new PurgeState(ctx.storage.sql);
    ctx.blockConcurrencyWhile(async () => {
      if (this.state.status().pending) await this.schedule(Date.now() + 1000);
    });
  }
  private schedule(at: number): Promise<void> {
    const work = this.alarmWrites
      .catch(() => {})
      .then(async () => {
        const current = await this.ctx.storage.getAlarm();
        if (current === null || current > at)
          await this.ctx.storage.setAlarm(at);
      });
    this.alarmWrites = work;
    return work;
  }
  async requestPurge() {
    // Pre-arm before persisting intent: once an intent exists, a crash cannot
    // leave it without an alarm. Empty recovery alarms safely stop themselves.
    await this.schedule(Date.now() + 1000);
    const ticket = this.state.enqueue();
    await this.flush();
    return {
      confirmed: this.state.read().completed >= ticket,
      ...this.state.status(),
    };
  }
  health() {
    return this.state.status();
  }
  private reportAlert() {
    const alert = this.state.transitionAlert();
    if (alert) {
      const payload = {
        event: "rebask.alert",
        kind: "purge_backlog",
        state: alert.active ? "firing" : "resolved",
        ...alert,
      };
      if (alert.active) console.error(payload);
      else console.log(payload);
    }
  }
  private async flush() {
    this.reportAlert();
    const pending = this.state.status();
    if (!pending.pending) return;
    // Recovery wake survives a crash during external I/O. Owner-fenced leases
    // make duplicate alarms/restarts safe. Do not hold a SQL transaction over RPC.
    await this.schedule(Date.now() + 30_000);
    const claim = this.state.claim();
    if (!claim) {
      await this.schedule(
        Math.max(
          Date.now() + 100,
          this.state.status().nextAttemptAt ?? Date.now() + 1000,
        ),
      );
      return;
    }
    try {
      await this.env.REBASK_SELF.purgePageCache();
      this.state.succeed(claim.token, claim.target);
      console.log({
        event: "rebask.purge",
        outcome: "success",
        ...this.state.status(),
      });
    } catch {
      const random =
        crypto.getRandomValues(new Uint32Array(1))[0]! / 0xffffffff;
      this.state.fail(claim.token, "platform-purge-failed", random);
      console.warn({
        event: "rebask.purge",
        outcome: "retry-scheduled",
        ...this.state.status(),
      });
    }
    this.reportAlert();
    const status = this.state.status();
    if (status.pending)
      await this.schedule(
        Math.max(Date.now() + 100, status.nextAttemptAt ?? Date.now() + 1000),
      );
    // Leave the already armed recovery wake. Deleting an alarm here could race
    // a concurrent enqueue. The one extra empty wake returns without rearming.
  }
  async alarm() {
    await this.flush();
  }
}
