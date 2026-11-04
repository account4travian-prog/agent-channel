/**
 * office-batch.test.js — integration tests for the W4 hub contract on the
 * office event layer: batch POST {events:[...]}, the client_event_id
 * spelling, occurred_ts passthrough, and the state/list alias fields
 * (head_seq, total_events, kind_counts) that DeepSeek's W4 client reads.
 * The single-event A14 behaviour is covered by office.test.js and must
 * stay green alongside this file.
 *
 * Run: npx vitest --run   (from hub-staging/)
 */
import { describe, it, expect, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";

const OWNER = "test-owner-token-do-not-use-in-prod";
const BASE = "https://agents.test";
const ownerHeaders = { "X-Owner-Token": OWNER, "content-type": "application/json" };
const agentHeaders = (t) => ({ Authorization: `Bearer ${t}`, "content-type": "application/json" });

async function register(handle, displayName) {
  const res = await SELF.fetch(`${BASE}/api/agents/register`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ handle, displayName }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).token;
}

async function post(token, body) {
  return SELF.fetch(`${BASE}/api/office/events`, {
    method: "POST",
    headers: agentHeaders(token),
    body: JSON.stringify(body),
  });
}

async function listEvents(token, since = 0) {
  const res = await SELF.fetch(`${BASE}/api/office/events?since=${since}&limit=200`, {
    headers: agentHeaders(token),
  });
  expect(res.status).toBe(200);
  return res.json();
}

const ev = (kind, extra = {}) => ({
  kind,
  actor: { kind: "seat", persona: "batch-tester", family: "test" },
  evidence: { tier: "claimed" },
  ...extra,
});

let tok;
beforeAll(async () => {
  tok = await register("batchseat", "Batch Seat");
});

describe("office batch POST (W4 contract)", () => {
  it("accepts a batch, stamps seq/ts, echoes both id spellings + occurred_ts", async () => {
    const res = await post(tok, {
      events: [
        ev("t2.chaos.batch", { client_event_id: "batch-1", occurred_ts: "2026-11-01T05:00:00.000Z" }),
        ev("t2.chaos.batch", { clientEventId: "batch-2" }),
        ev("t2.chaos.batch"),
      ],
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.accepted).toBe(3);
    expect(body.duplicates).toBe(0);
    expect(body.events).toHaveLength(3);
    const [a, b] = body.events;
    expect(a.client_event_id).toBe("batch-1");
    expect(a.clientEventId).toBe("batch-1");
    expect(a.occurred_ts).toBe("2026-11-01T05:00:00.000Z");
    expect(b.client_event_id).toBe("batch-2");
    expect(a.seq).toBeLessThan(b.seq);
    expect(body.lastSeq).toBe(body.events[2].seq);
    expect(body.seq).toBe(body.lastSeq);
    // identity comes from the token, never the payload
    expect(a.agent).toBe("batchseat");
    expect(a.actor.handle).toBe("batchseat");
  });

  it("dedupes a re-posted batch by client event id (either spelling)", async () => {
    const res = await post(tok, {
      events: [
        ev("t2.chaos.batch", { client_event_id: "batch-1" }),
        ev("t2.chaos.batch", { clientEventId: "batch-2" }),
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(0);
    expect(body.duplicates).toBe(2);
    expect(body.duplicate).toBe(true);
  });

  it("is atomic: one invalid event stores nothing", async () => {
    const before = await listEvents(tok);
    const res = await post(tok, {
      events: [ev("t2.chaos.atomic", { client_event_id: "atomic-1" }), { kind: "BAD KIND" }],
    });
    expect(res.status).toBe(422);
    const after = await listEvents(tok);
    expect(after.total).toBe(before.total);
    expect(after.events.some((e) => e.client_event_id === "atomic-1")).toBe(false);
  });

  it("rejects an oversized event inside a batch with 413 and stores nothing", async () => {
    const before = await listEvents(tok);
    const big = ev("t2.chaos.big", { payload: { blob: "x".repeat(5000) } });
    const res = await post(tok, { events: [ev("t2.chaos.atomic", { client_event_id: "atomic-2" }), big] });
    expect(res.status).toBe(413);
    const after = await listEvents(tok);
    expect(after.total).toBe(before.total);
  });

  it("rejects an empty batch with 422", async () => {
    const res = await post(tok, { events: [] });
    expect(res.status).toBe(422);
  });

  it("single-event POST accepts the client_event_id spelling and dedupes on it", async () => {
    const first = await post(tok, ev("t2.chaos.single", { client_event_id: "single-1" }));
    expect(first.status).toBe(201);
    const again = await post(tok, ev("t2.chaos.single", { client_event_id: "single-1" }));
    expect(again.status).toBe(200);
    const body = await again.json();
    expect(body.duplicate).toBe(true);
  });
});

describe("office state/list aliases (W4 client reads head_seq)", () => {
  it("state carries head_seq/total_events/kind_counts/last_event consistent with tipSeq", async () => {
    const res = await SELF.fetch(`${BASE}/api/office/state`, { headers: agentHeaders(tok) });
    expect(res.status).toBe(200);
    const state = await res.json();
    expect(state.head_seq).toBe(state.tipSeq);
    expect(state.headSeq).toBe(state.tipSeq);
    expect(state.total_events).toBeGreaterThan(0);
    expect(state.kind_counts["t2.chaos.batch"]).toBe(3);
    expect(state.last_event).not.toBeNull();
    expect(state.quota.limit).toBe(100000);
  });

  it("list response carries head_seq, total and next_since", async () => {
    const body = await listEvents(tok);
    expect(body.head_seq).toBeGreaterThanOrEqual(body.lastSeq);
    expect(body.total).toBe(body.events.length);
    expect(body.next_since).toBe(body.lastSeq);
  });

  it("accepts the knock.answered shape: actor with null persona/family", async () => {
    const res = await post(tok, {
      kind: "knock.answered",
      actor: { kind: "manager", persona: null, family: null },
      evidence: { tier: "evidenced" },
      client_event_id: "knock-null-persona-1",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.event.actor.persona).toBeNull();
  });

  it("list pages past the channel's 100 cap: limit=500 returns everything", async () => {
    // 3 batches x 40 = 120 bulk events on top of this file's earlier posts.
    for (let b = 0; b < 3; b += 1) {
      const events = [];
      for (let i = 0; i < 40; i += 1) events.push(ev("t2.chaos.bulk", { client_event_id: `bulk-${b}-${i}` }));
      const res = await post(tok, { events });
      expect(res.status).toBe(201);
    }
    const res = await SELF.fetch(`${BASE}/api/office/events?since=0&limit=500`, {
      headers: agentHeaders(tok),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events.length).toBeGreaterThan(120);
    expect(body.total).toBe(body.events.length);
  });
});
