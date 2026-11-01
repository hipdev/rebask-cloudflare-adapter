import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { PurgeState } from "../dist/purge-state.js";
function setup() {
  const db = new DatabaseSync(":memory:");
  let now = 1000;
  const sql = {
    exec(query, ...args) {
      if (query.includes("CREATE TABLE")) {
        db.exec(query);
        return { toArray: () => [] };
      }
      const statement = db.prepare(query);
      const rows = statement.columns().length
        ? statement.all(...args)
        : (statement.run(...args), []);
      return {
        one: () => {
          assert.equal(rows.length, 1);
          return rows[0];
        },
        toArray: () => rows,
      };
    },
  };
  return {
    sql,
    now: () => now,
    advance: (ms) => (now += ms),
    state: () => new PurgeState(sql, () => now),
  };
}
test("purge intent and retry schedule survive recreation, including beyond platform alarm retries", () => {
  const s = setup();
  let state = s.state();
  state.enqueue();
  for (let i = 0; i < 9; i++) {
    const claim = state.claim();
    assert.ok(claim);
    state.fail(claim.token, "platform-purge-failed", 0);
    const old = state.status();
    state = s.state();
    assert.equal(state.status().attempts, i + 1);
    assert.ok(state.status().pending);
    s.advance(old.nextAttemptAt - s.now());
  }
  const claim = state.claim();
  state.succeed(claim.token, claim.target);
  assert.equal(state.status().pending, false);
  assert.equal(state.status().failures, 9);
});
test("concurrent enqueues coalesce without old acknowledgments clearing newer work", () => {
  const s = setup(),
    state = s.state();
  state.enqueue();
  const first = state.claim();
  for (let i = 0; i < 100; i++) state.enqueue();
  assert.equal(state.claim(), null);
  state.succeed(first.token, first.target);
  assert.ok(state.status().pending);
  assert.equal(state.status().completed, 1);
  s.advance(1000);
  const next = state.claim();
  assert.equal(next.target, 101);
  state.succeed(next.token, next.target);
  assert.equal(state.status().pending, false);
  assert.equal(state.status().purges, 2);
});
test("expired owners cannot acknowledge or fail a newer purge lease", () => {
  const s = setup(),
    state = s.state();
  state.enqueue();
  const old = state.claim();
  s.advance(30_001);
  const current = state.claim();
  assert.equal(state.succeed(old.token, old.target), false);
  assert.equal(state.fail(old.token, "old", 0), false);
  state.succeed(current.token, current.target);
  assert.equal(state.status().pending, false);
});
test("purge backlog alert transitions persist and resolve without duplicate firing", () => {
  const s = setup(),
    state = s.state();
  state.enqueue();
  for (let i = 0; i < 3; i++) {
    const c = state.claim();
    state.fail(c.token, "platform-purge-failed", 0);
    s.advance(state.status().nextAttemptAt - s.now());
  }
  assert.equal(state.transitionAlert().active, true);
  assert.equal(s.state().status().alertActive, true);
  assert.equal(state.transitionAlert(), null);
  const c = state.claim();
  state.succeed(c.token, c.target);
  assert.equal(state.transitionAlert().active, false);
  assert.equal(state.transitionAlert(), null);
});
test("pending age can fire an alert even while an owner lease prevents a retry", () => {
  const s = setup(),
    state = s.state();
  state.enqueue();
  s.advance(60_001);
  assert.equal(state.transitionAlert().active, true);
});
