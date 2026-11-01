/** One bounded, durable outbox row. No URLs, auth data or application tags. */
export interface PurgeRow {
  [key: string]: SqlStorageValue;
  requested: number;
  completed: number;
  attempts: number;
  first_pending: number;
  next_at: number;
  token: string | null;
  lease_until: number;
  alert: number;
  requests: number;
  successes: number;
  failures: number;
  last_error: string | null;
}
export class PurgeState {
  constructor(
    private sql: Pick<SqlStorage, "exec">,
    private now = Date.now,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS purge_outbox (id INTEGER PRIMARY KEY CHECK(id=1),requested INTEGER NOT NULL,completed INTEGER NOT NULL,attempts INTEGER NOT NULL,first_pending INTEGER NOT NULL,next_at INTEGER NOT NULL,token TEXT,lease_until INTEGER NOT NULL,alert INTEGER NOT NULL,requests INTEGER NOT NULL,successes INTEGER NOT NULL,failures INTEGER NOT NULL,last_error TEXT);
      INSERT OR IGNORE INTO purge_outbox VALUES(1,0,0,0,0,0,NULL,0,0,0,0,0,NULL);`);
  }
  read(): PurgeRow {
    return this.sql
      .exec<PurgeRow>("SELECT * FROM purge_outbox WHERE id=1")
      .one();
  }
  enqueue() {
    this.sql.exec(
      "UPDATE purge_outbox SET requested=requested+1,requests=requests+1,first_pending=CASE WHEN requested=completed THEN ? ELSE first_pending END WHERE id=1",
      this.now(),
    );
    return this.read().requested;
  }
  claim() {
    const row = this.read(),
      now = this.now();
    if (
      row.requested <= row.completed ||
      row.next_at > now ||
      row.lease_until > now
    )
      return null;
    const token = crypto.randomUUID();
    this.sql.exec(
      "UPDATE purge_outbox SET token=?,lease_until=? WHERE id=1",
      token,
      now + 30_000,
    );
    return { token, target: row.requested };
  }
  succeed(token: string, target: number) {
    const row = this.read();
    if (row.token !== token) return false;
    this.sql.exec(
      "UPDATE purge_outbox SET completed=MAX(completed,?),attempts=0,token=NULL,lease_until=0,next_at=?,successes=successes+1,last_error=NULL WHERE id=1",
      target,
      this.now() + 1000,
    );
    return true;
  }
  fail(token: string, category: string, jitter: number) {
    const row = this.read();
    if (row.token !== token) return false;
    const delay =
      Math.min(300_000, 1000 * 2 ** Math.min(row.attempts, 12)) +
      Math.floor(Math.max(0, Math.min(jitter, 1)) * 1000);
    this.sql.exec(
      "UPDATE purge_outbox SET attempts=attempts+1,failures=failures+1,token=NULL,lease_until=0,next_at=?,last_error=? WHERE id=1",
      this.now() + delay,
      category,
    );
    return true;
  }
  transitionAlert() {
    const row = this.read();
    const active =
      row.requested > row.completed &&
      (row.attempts >= 3 || this.now() - row.first_pending >= 60_000);
    if (active === !!row.alert) return null;
    this.sql.exec("UPDATE purge_outbox SET alert=? WHERE id=1", active ? 1 : 0);
    return {
      active,
      attempts: row.attempts,
      pendingAgeMs: active ? this.now() - row.first_pending : 0,
    };
  }
  status() {
    const r = this.read(),
      pending = r.requested > r.completed;
    return {
      pending,
      requested: r.requested,
      completed: r.completed,
      attempts: r.attempts,
      pendingAgeMs: pending ? Math.max(0, this.now() - r.first_pending) : 0,
      nextAttemptAt: pending ? Math.max(r.next_at, r.lease_until) : null,
      alertActive: !!r.alert,
      requests: r.requests,
      purges: r.successes,
      failures: r.failures,
      lastError: r.last_error,
    };
  }
}
