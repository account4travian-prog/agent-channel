/**
 * office.test.js — integration tests for the office event layer
 * (POST/GET /api/office/events, GET /api/office/state, /ws frames)
 * against the real Worker + RoomObject in the Workers runtime.
 *
 * Run: npx vitest --run   (from hub-staging/)
 *
 * NEGATIVE-WITNESS checks: bad token -> 401 on every office surface,
 * oversize payload -> 413, spoofed payload handle ignored, claimed
 * activity never derives the "live" work class.
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

async function postEvent(token, body, rawOverride) {
  return SELF.fetch(`${BASE}/api/office/events`, {
    method: "POST",
    headers: agentHeaders(token),
    body: rawOverride !== undefined ? rawOverride : JSON.stringify(body),
  });
}

async function getState(token) {
  const res = await SELF.fetch(`${BASE}/api/office/state`, { headers: agentHeaders(token) });
  expect(res.status).toBe(200);
  return res.json();
}

const agentOf = (state, handle) => state.agents.find((a) => a.handle === handle);

let lead, builder, ghost, sess, away;
beforeAll(async () => {
  lead = await register("officelead", "Office Lead");
  builder = await register("officebuilder", "Office Builder");
  ghost = await register("officeghost", "Never Seen"); // no signals, ever
  sess = await register("officesess", "Scheduled Seat");
  away = await register("officeaway", "Away Seat");
});

// --- auth (negative witness) -----------------------------------------------------

describe("office auth", () => {
  it("POST /api/office/events with NO token -> 401", async () => {
    const res = await SELF.fetch(`${BASE}/api/office/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "artifact.produced" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/office/events with a BAD token -> 401", async () => {
    const res = await postEvent("not-a-real-token", { kind: "artifact.produced" });
    expect(res.status).toBe(401);
  });

  it("GET /api/office/events with a BAD token -> 401", async () => {
    const res = await SELF.fetch(`${BASE}/api/office/events?since=0`, {
      headers: agentHeaders("not-a-real-token"),
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/office/state with a BAD token -> 401", async () => {
    const res = await SELF.fetch(`${BASE}/api/office/state`, {
      headers: agentHeaders("not-a-real-token"),
    });
    expect(res.status).toBe(401);
  });
});

// --- envelope gates ------------------------------------------------------------

describe("office envelope gates", () => {
  it("oversize payload (>4KB) -> 413", async () => {
    const big = { kind: "artifact.produced", payload: { blob: "x".repeat(5000) } };
    const res = await postEvent(lead, big);
    expect(res.status).toBe(413);
  });

  it("bad kind -> 422; bad evidence tier -> 422; bad JSON -> 400", async () => {
    expect((await postEvent(lead, { kind: "nodots" })).status).toBe(422);
    expect(
      (await postEvent(lead, { kind: "a.b", evidence: { tier: "proven" } })).status
    ).toBe(422);
    expect((await postEvent(lead, null, "{not json")).status).toBe(400);
  });
});

// --- append, seq, identity stamping ---------------------------------------------

let seq1, seq2;
describe("office append + seq", () => {
  it("first post -> 201 seq>=1, server stamps ts and agent identity", async () => {
    const res = await postEvent(lead, {
      kind: "artifact.produced",
      seq: 9999, // spoof attempts: all ignored
      ts: 1,
      agent: "officebuilder",
      actor: { kind: "seat", handle: "officebuilder", persona: "alpha-lead", family: "deepseek" },
      evidence: { tier: "evidenced" },
      project: "PRJ-001",
      refs: { artifact: "projects/x.mjs" },
      payload: { sha256: "abc" },
    });
    expect(res.status).toBe(201);
    const d = await res.json();
    seq1 = d.seq;
    expect(seq1).toBeGreaterThanOrEqual(1);
    expect(d.event.seq).toBe(seq1);
    expect(d.event.agent).toBe("officelead"); // token-stamped, NOT the payload's claim
    expect(d.event.actor.handle).toBe("officelead");
    expect(d.event.actor.persona).toBe("alpha-lead");
    expect(d.event.ts).toBeGreaterThan(1_000_000_000_000);
    expect(d.event.evidence.source).toBe("hub");
  });

  it("seq is strictly monotonic across posts and agents", async () => {
    const r2 = await postEvent(builder, { kind: "run.started", evidence: { tier: "claimed" } });
    expect(r2.status).toBe(201);
    seq2 = (await r2.json()).seq;
    expect(seq2).toBeGreaterThan(seq1);
    const r3 = await postEvent(lead, { kind: "run.finished", evidence: { tier: "evidenced" } });
    expect((await r3.json()).seq).toBeGreaterThan(seq2);
  });

  it("since-cursor returns only later events, ascending", async () => {
    const res = await SELF.fetch(`${BASE}/api/office/events?since=${seq1}`, {
      headers: agentHeaders(builder),
    });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.events.length).toBeGreaterThanOrEqual(2);
    expect(d.events[0].seq).toBe(seq2);
    const seqs = d.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(d.lastSeq).toBe(seqs[seqs.length - 1]);
  });
});

// --- dedupe ----------------------------------------------------------------------

describe("office dedupe by clientEventId", () => {
  it("same agent + same clientEventId -> duplicate:true, original seq, one stored event", async () => {
    const body = { kind: "check.passed", clientEventId: "evt-dup-1", evidence: { tier: "evidenced" } };
    const r1 = await postEvent(lead, body);
    expect(r1.status).toBe(201);
    const first = await r1.json();

    const r2 = await postEvent(lead, body);
    expect(r2.status).toBe(200);
    const second = await r2.json();
    expect(second.duplicate).toBe(true);
    expect(second.seq).toBe(first.seq);

    const list = await (
      await SELF.fetch(`${BASE}/api/office/events?since=0&limit=100`, {
        headers: agentHeaders(lead),
      })
    ).json();
    const stored = list.events.filter((e) => e.clientEventId === "evt-dup-1");
    expect(stored.length).toBe(1);
  });

  it("a DIFFERENT agent may reuse the same clientEventId (per-agent key)", async () => {
    const r = await postEvent(builder, { kind: "check.passed", clientEventId: "evt-dup-1" });
    expect(r.status).toBe(201);
    const d = await r.json();
    expect(d.event.agent).toBe("officebuilder");
  });

  it("no clientEventId -> no dedupe: identical posts get distinct seqs", async () => {
    const body = { kind: "note.added", payload: { n: 1 } };
    const a = await (await postEvent(lead, body)).json();
    const b = await (await postEvent(lead, body)).json();
    expect(b.seq).toBeGreaterThan(a.seq);
  });
});

// --- derived state -----------------------------------------------------------------

describe("office state derivation", () => {
  it("fresh EVIDENCED work -> class live", async () => {
    // Post fresh evidenced work so the lead's latest event is the work
    // event itself (earlier describes left claimed notes on top).
    await postEvent(lead, { kind: "work.verified", evidence: { tier: "evidenced" } });
    const st = await getState(builder);
    const me = agentOf(st, "officelead");
    expect(me.class).toBe("live");
    expect(me.activity.tier).toBe("evidenced");
    expect(me.activity.tentative).toBe(false);
    expect(st.tipSeq).toBeGreaterThanOrEqual(seq2);
    expect(st.quota.limit).toBe(100_000);
    expect(st.quota.alarmAt).toBe(70_000);
  });

  it("seat with no signals at all -> unknown, never absent, still listed", async () => {
    const st = await getState(lead);
    const g = agentOf(st, "officeghost");
    expect(g).toBeDefined();
    expect(g.class).toBe("unknown");
    expect(g.activity).toBe(null);
  });

  it("CLAIMED-only fresh activity -> not live, flagged tentative", async () => {
    await postEvent(builder, { kind: "work.claimed", evidence: { tier: "claimed" } });
    const st = await getState(lead);
    const b = agentOf(st, "officebuilder");
    expect(b.class).not.toBe("live");
    expect(b.activity.tentative).toBe(true);
  });

  it("claimed checkin + heartbeat -> in_session (scheduled-seat class)", async () => {
    await postEvent(sess, { kind: "presence.checkin", evidence: { tier: "claimed" } });
    await SELF.fetch(`${BASE}/api/heartbeat`, { method: "POST", headers: agentHeaders(sess) });
    const st = await getState(lead);
    expect(agentOf(st, "officesess").class).toBe("in_session");
  });

  it("declared away with a future until -> away_scheduled + nextExpectedTs", async () => {
    const until = Date.now() + 3_600_000;
    await postEvent(away, {
      kind: "presence.away",
      evidence: { tier: "claimed" },
      payload: { until },
    });
    const st = await getState(lead);
    const a = agentOf(st, "officeaway");
    expect(a.class).toBe("away_scheduled");
    expect(a.nextExpectedTs).toBe(until);
  });

  it("office stream is SEPARATE: channel messages unaffected by office posts", async () => {
    const post = await SELF.fetch(`${BASE}/api/messages`, {
      method: "POST",
      headers: agentHeaders(lead),
      body: JSON.stringify({ to: "broadcast", body: "channel still works" }),
    });
    expect(post.status).toBe(201);
    const list = await (
      await SELF.fetch(`${BASE}/api/messages?since=0&limit=100`, {
        headers: agentHeaders(builder),
      })
    ).json();
    expect(list.messages.some((m) => m.body === "channel still works")).toBe(true);
    expect(list.messages.some((m) => m.kind === "artifact.produced")).toBe(false);
  });
});

// --- /ws office frames -------------------------------------------------------------

describe("office frames on /ws", () => {
  it("a live socket receives {t:'office_event'} when another seat posts", async () => {
    const res = await SELF.fetch(`${BASE}/ws`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${builder}` },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    ws.accept();
    const frames = [];
    const gotOffice = new Promise((resolve) => {
      ws.addEventListener("message", (ev) => {
        try {
          const f = JSON.parse(ev.data);
          frames.push(f);
          if (f.t === "office_event") resolve(f);
        } catch { /* ignore */ }
      });
      setTimeout(() => resolve(null), 3000);
    });
    // Give the socket a beat to register, then post from the other seat.
    await new Promise((r) => setTimeout(r, 250));
    await postEvent(lead, { kind: "frame.test", evidence: { tier: "evidenced" } });
    const frame = await gotOffice;
    expect(frame).not.toBe(null);
    expect(frame.event.kind).toBe("frame.test");
    expect(frame.event.agent).toBe("officelead");
    ws.close();
  });
});
