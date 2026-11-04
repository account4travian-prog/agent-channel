/**
 * office-logic.test.js — node:test suite for worker/src/office.js.
 * Run as part of: npm test   (from hub-staging/)
 *
 * Covers the pure half of the office layer: envelope validation,
 * the 4 KB cap, dedupe-id validation, quota thresholds, and the
 * presence-class derivation matrix — including NEGATIVE-WITNESS
 * cases (spoofed fields never survive validation; no signal set
 * ever derives "absent").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateOfficeEvent,
  isValidClientEventId,
  officeBodyTooBig,
  deriveOfficePresence,
  quotaStatus,
  OFFICE_PRESENCE_TTL_MS,
} from "../src/office.js";

const NOW = 1_800_000_000_000;
const fresh = (ageMs) => NOW - ageMs;
const base = {
  hasHistory: false,
  socketLive: false,
  lastHeartbeatTs: null,
  lastWorkTs: null,
  lastAnyEventTs: null,
  sessionOpen: false,
  awayUntilTs: null,
};

// --- envelope validation -------------------------------------------------------

test("validateOfficeEvent: minimal valid event, defaults applied", () => {
  const v = validateOfficeEvent({ kind: "artifact.produced" });
  assert.equal(v.error, undefined);
  assert.equal(v.event.kind, "artifact.produced");
  assert.equal(v.event.actor.kind, "seat");
  assert.equal(v.event.evidence.tier, "claimed"); // default: never self-evidenced
  assert.equal(v.event.clientEventId, null);
});

test("validateOfficeEvent: full envelope survives; spoof fields do not", () => {
  const v = validateOfficeEvent({
    kind: "check.passed",
    seq: 9999, // client-supplied seq must be dropped
    ts: 1, // client-supplied ts must be dropped
    agent: "mallory", // client-supplied agent must be dropped
    actor: { kind: "verifier", handle: "mallory", persona: "verifier-1", family: "deepseek" },
    evidence: { tier: "evidenced", source: "forged" },
    project: "PRJ-001",
    run: "RUN-1",
    refs: { artifact: "projects/x.mjs", sha256: "abc" },
    payload: { sha256: "abc", bytes: 12 },
    clientEventId: "evt-1",
  });
  assert.equal(v.error, undefined);
  assert.equal("seq" in v.event, false);
  assert.equal("ts" in v.event, false);
  assert.equal("agent" in v.event, false);
  assert.equal("handle" in v.event.actor, false); // stamped by the server from the token
  assert.equal(v.event.actor.persona, "verifier-1");
  assert.equal(v.event.evidence.tier, "evidenced");
  assert.equal("source" in v.event.evidence, false); // server stamps source: "hub"
  assert.equal(v.event.clientEventId, "evt-1");
});

test("validateOfficeEvent: rejects bad kinds, tiers, actor kinds", () => {
  assert.ok(validateOfficeEvent({ kind: "nodots" }).error);
  assert.ok(validateOfficeEvent({ kind: "Bad.Kind" }).error);
  assert.ok(validateOfficeEvent({ kind: 42 }).error);
  assert.ok(validateOfficeEvent({ kind: "a.b", evidence: { tier: "proven" } }).error);
  assert.ok(validateOfficeEvent({ kind: "a.b", actor: { kind: "admin" } }).error);
  assert.ok(validateOfficeEvent(null).error);
  assert.ok(validateOfficeEvent([1, 2]).error);
  assert.ok(validateOfficeEvent({ kind: "a.b", refs: { x: 5 } }).error);
  assert.ok(validateOfficeEvent({ kind: "a.b", payload: "text" }).error);
  assert.ok(validateOfficeEvent({ kind: "a.b", clientEventId: "" }).error);
  assert.ok(validateOfficeEvent({ kind: "a.b", clientEventId: "x".repeat(129) }).error);
});

test("validateOfficeEvent: null persona/family are absent, not invalid (knock.answered regression)", () => {
  // The real office log's knock.answered events (the owner's door answers)
  // carry actor {kind:"manager", persona:null, family:null} through the W4
  // client's buildHubEvent. The first mirror sync stalled on exactly this.
  const v = validateOfficeEvent({
    kind: "knock.answered",
    actor: { kind: "manager", persona: null, family: null },
    evidence: { tier: "evidenced" },
    client_event_id: "abc123",
  });
  assert.equal(v.error, undefined);
  assert.equal(v.event.actor.persona, null);
  assert.equal(v.event.actor.family, null);
  assert.equal(v.event.clientEventId, "abc123");
});

test("isValidClientEventId bounds", () => {
  assert.equal(isValidClientEventId("a"), true);
  assert.equal(isValidClientEventId("x".repeat(128)), true);
  assert.equal(isValidClientEventId("x".repeat(129)), false);
  assert.equal(isValidClientEventId(""), false);
  assert.equal(isValidClientEventId(7), false);
  assert.equal(isValidClientEventId(null), false);
});

test("officeBodyTooBig: 4 KB cap on UTF-8 bytes, not chars", () => {
  assert.equal(officeBodyTooBig("x".repeat(4096)), false);
  assert.equal(officeBodyTooBig("x".repeat(4097)), true);
  // A 2-byte char: 2049 chars = 4098 bytes -> too big.
  assert.equal(officeBodyTooBig("é".repeat(2049)), true);
  assert.equal(officeBodyTooBig("é".repeat(2048)), false);
  assert.equal(officeBodyTooBig(null), true);
});

// --- quota ---------------------------------------------------------------------

test("quotaStatus: alarm at 70%, shed at 90%, of 100k/day", () => {
  assert.deepEqual(quotaStatus(0), {
    requestsToday: 0,
    limit: 100_000,
    alarmAt: 70_000,
    alarm: false,
    shedding: false,
  });
  assert.equal(quotaStatus(69_999).alarm, false);
  assert.equal(quotaStatus(70_000).alarm, true);
  assert.equal(quotaStatus(89_999).shedding, false);
  assert.equal(quotaStatus(90_000).shedding, true);
  assert.equal(quotaStatus(undefined).requestsToday, 0);
});

// --- presence derivation ---------------------------------------------------------

test("deriveOfficePresence: never seen -> unknown, never absent", () => {
  assert.equal(deriveOfficePresence({ ...base }, NOW), "unknown");
});

test("deriveOfficePresence: evidenced work inside TTL -> live", () => {
  const cls = deriveOfficePresence(
    { ...base, hasHistory: true, lastWorkTs: fresh(5_000), lastAnyEventTs: fresh(5_000) },
    NOW
  );
  assert.equal(cls, "live");
});

test("deriveOfficePresence: claimed-only activity is NOT live", () => {
  const cls = deriveOfficePresence(
    { ...base, hasHistory: true, lastAnyEventTs: fresh(5_000) },
    NOW
  );
  assert.equal(cls, "present_idle"); // fresh signal, no socket, no session
});

test("deriveOfficePresence: socket + fresh heartbeat, no work -> awake", () => {
  const cls = deriveOfficePresence(
    { ...base, hasHistory: true, socketLive: true, lastHeartbeatTs: fresh(1_000) },
    NOW
  );
  assert.equal(cls, "awake");
});

test("deriveOfficePresence: open session inside TTL -> in_session", () => {
  const cls = deriveOfficePresence(
    {
      ...base,
      hasHistory: true,
      sessionOpen: true,
      lastAnyEventTs: fresh(60_000),
      socketLive: true,
    },
    NOW
  );
  assert.equal(cls, "in_session");
});

test("deriveOfficePresence: declared away, not expired -> away_scheduled", () => {
  const cls = deriveOfficePresence(
    { ...base, hasHistory: true, awayUntilTs: NOW + 3_600_000, lastHeartbeatTs: fresh(10_000) },
    NOW
  );
  assert.equal(cls, "away_scheduled");
});

test("deriveOfficePresence: EXPIRED away declaration -> stale (overdue), not a work state", () => {
  const cls = deriveOfficePresence(
    {
      ...base,
      hasHistory: true,
      awayUntilTs: NOW - 60_000,
      lastHeartbeatTs: fresh(OFFICE_PRESENCE_TTL_MS + 1_000),
    },
    NOW
  );
  assert.equal(cls, "stale");
});

test("deriveOfficePresence: history but everything past TTL -> stale", () => {
  const old = fresh(OFFICE_PRESENCE_TTL_MS + 1);
  const cls = deriveOfficePresence(
    { ...base, hasHistory: true, lastWorkTs: old, lastAnyEventTs: old, lastHeartbeatTs: old },
    NOW
  );
  assert.equal(cls, "stale");
});

test("deriveOfficePresence: live socket alone (no timestamps) reads awake, not unknown", () => {
  const cls = deriveOfficePresence({ ...base, socketLive: true }, NOW);
  assert.equal(cls, "awake");
});

test("deriveOfficePresence: work exactly at TTL boundary still counts", () => {
  const cls = deriveOfficePresence(
    { ...base, hasHistory: true, lastWorkTs: fresh(OFFICE_PRESENCE_TTL_MS), lastAnyEventTs: fresh(OFFICE_PRESENCE_TTL_MS) },
    NOW
  );
  assert.equal(cls, "live");
});
