/**
 * office.js — pure, dependency-free logic for the Office event layer.
 *
 * The office stream is a SEPARATE append-only stream from channel
 * messages (own table, own seq), kept to the same record-keeping
 * discipline: server-assigned seq/ts, token-stamped agent identity
 * (any handle inside the payload is ignored), refs-not-content
 * payloads capped at 4 KB, and dedupe by client event id.
 *
 * Presence classes are SERVER-DERIVED at read time from evidence —
 * heartbeats, live sockets, and the office event stream — never from
 * anything a client asserts. The classes are the SYNTHESIS v3 §6 set:
 *   live / awake / present_idle / away_scheduled / in_session /
 *   stale / unknown
 * `unknown` is the honest floor: a seat with no signals is unknown,
 * NEVER "absent". Work states expire after a 120s TTL, derived lazily
 * at read time (no per-agent alarms — those would break hibernation).
 * Only `evidenced` events count as work activity; `claimed` activity
 * renders tentative.
 *
 * Like logic.js, nothing here may touch Workers APIs so the same code
 * runs under node:test.
 */

// ---------------------------------------------------------------------------
// Limits (frozen envelope — DeepSeek office PLAN §3.5, SYNTHESIS v3 §6)
// ---------------------------------------------------------------------------

/** Max size of one office event POST body, UTF-8 bytes (refs, not content). */
export const OFFICE_MAX_EVENT_BYTES = 4096;

/** Max events in one batch POST (W4 client default batch is 10). */
export const OFFICE_MAX_BATCH_EVENTS = 100;

/** Hard cap on a whole batch request body, UTF-8 bytes. */
export const OFFICE_MAX_BATCH_BYTES = 262144;

/** Work-state TTL: presence derived from signals older than this is stale. */
export const OFFICE_PRESENCE_TTL_MS = 120_000;

/** Free-tier daily request budget the hub must stay under (H7). */
export const OFFICE_QUOTA_LIMIT_PER_DAY = 100_000;

/** Quota alarm threshold: 70% of the daily budget (SYNTHESIS v3 §6). */
export const OFFICE_QUOTA_ALARM_PER_DAY = 70_000;

/** Existing hub shed threshold (room.js SHED_THRESHOLD): presence sheds. */
export const OFFICE_QUOTA_SHED_PER_DAY = 90_000;

export function quotaStatus(requestsToday) {
  const n = Number.isSafeInteger(requestsToday) && requestsToday > 0 ? requestsToday : 0;
  return {
    requestsToday: n,
    limit: OFFICE_QUOTA_LIMIT_PER_DAY,
    alarmAt: OFFICE_QUOTA_ALARM_PER_DAY,
    alarm: n >= OFFICE_QUOTA_ALARM_PER_DAY,
    shedding: n >= OFFICE_QUOTA_SHED_PER_DAY,
  };
}

// ---------------------------------------------------------------------------
// Event validation
// ---------------------------------------------------------------------------

const KIND_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
export const OFFICE_ACTOR_KINDS = new Set(["office", "seat", "manager", "verifier"]);
export const OFFICE_EVIDENCE_TIERS = new Set(["evidenced", "claimed"]);

/** Client event id: a string of 1..128 chars (dedupe key, per agent). */
export function isValidClientEventId(v) {
  return typeof v === "string" && v.length >= 1 && v.length <= 128;
}

/** True when the raw POST body exceeds the 4 KB envelope cap (UTF-8 bytes). */
export function officeBodyTooBig(rawText) {
  if (typeof rawText !== "string") return true;
  return new TextEncoder().encode(rawText).length > OFFICE_MAX_EVENT_BYTES;
}

/** True when one event object serializes past the 4 KB envelope cap. */
export function officeEventTooBig(ev) {
  try {
    return new TextEncoder().encode(JSON.stringify(ev)).length > OFFICE_MAX_EVENT_BYTES;
  } catch {
    return true;
  }
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optString(v, max) {
  return typeof v === "string" && v.length <= max ? v : null;
}

/**
 * Validate + normalize a client-submitted office event.
 *
 * The caller (room.js) stamps seq, ts, and agent identity from the
 * token — anything the client puts in `seq`, `ts`, `agent`, or
 * `actor.handle` is IGNORED here by construction (never copied out).
 *
 * @param {unknown} body parsed JSON body
 * @returns {{error:string}|{event:object}} normalized event fields
 *   (without seq/ts/agent — the server stamps those)
 */
export function validateOfficeEvent(body) {
  if (!isPlainObject(body)) return { error: "event must be a JSON object" };

  if (typeof body.kind !== "string" || body.kind.length > 64 || !KIND_RE.test(body.kind)) {
    return { error: 'kind must be a dotted event kind like "artifact.produced" (<=64 chars)' };
  }

  const actorIn = isPlainObject(body.actor) ? body.actor : {};
  const actorKind = actorIn.kind === undefined ? "seat" : actorIn.kind;
  if (!OFFICE_ACTOR_KINDS.has(actorKind)) {
    return { error: 'actor.kind must be one of "office"|"seat"|"manager"|"verifier"' };
  }
  const persona = optString(actorIn.persona, 64);
  if (actorIn.persona !== undefined && actorIn.persona !== null && persona === null) {
    return { error: "actor.persona must be a string up to 64 chars" };
  }
  const family = optString(actorIn.family, 64);
  if (actorIn.family !== undefined && actorIn.family !== null && family === null) {
    return { error: "actor.family must be a string up to 64 chars" };
  }

  const evIn = isPlainObject(body.evidence) ? body.evidence : {};
  const tier = evIn.tier === undefined ? "claimed" : evIn.tier;
  if (!OFFICE_EVIDENCE_TIERS.has(tier)) {
    return { error: 'evidence.tier must be "evidenced" or "claimed"' };
  }

  const project = optString(body.project, 128);
  if (body.project !== undefined && body.project !== null && project === null) {
    return { error: "project must be a string up to 128 chars" };
  }
  const run = optString(body.run, 128);
  if (body.run !== undefined && body.run !== null && run === null) {
    return { error: "run must be a string up to 128 chars" };
  }

  let refs = {};
  if (body.refs !== undefined) {
    if (!isPlainObject(body.refs)) return { error: "refs must be an object of string values" };
    for (const [k, v] of Object.entries(body.refs)) {
      if (k.length > 64 || typeof v !== "string" || v.length > 512) {
        return { error: "refs keys <=64 chars, values strings <=512 chars (refs, not content)" };
      }
    }
    refs = body.refs;
  }

  let payload = {};
  if (body.payload !== undefined) {
    if (!isPlainObject(body.payload)) return { error: "payload must be a JSON object" };
    payload = body.payload;
  }

  // The W4 hub contract spells the dedupe key client_event_id; the A14
  // fixtures spell it clientEventId. Accept either; store both.
  let clientEventId = null;
  const rawClientId =
    body.clientEventId !== undefined && body.clientEventId !== null
      ? body.clientEventId
      : body.client_event_id;
  if (rawClientId !== undefined && rawClientId !== null) {
    if (!isValidClientEventId(rawClientId)) {
      return { error: "clientEventId must be a string of 1..128 chars" };
    }
    clientEventId = rawClientId;
  }

  // occurred_ts: when the event happened at its source (the local log's
  // ts for mirrored events). Optional ISO string; the hub's own ts stays
  // the arrival/record time.
  let occurredTs = null;
  if (body.occurred_ts !== undefined && body.occurred_ts !== null) {
    if (typeof body.occurred_ts !== "string" || body.occurred_ts.length > 64) {
      return { error: "occurred_ts must be an ISO string up to 64 chars" };
    }
    occurredTs = body.occurred_ts;
  }

  return {
    event: {
      kind: body.kind,
      actor: { kind: actorKind, persona, family },
      evidence: { tier },
      project,
      run,
      refs,
      payload,
      clientEventId,
      occurredTs,
    },
  };
}

// ---------------------------------------------------------------------------
// Presence derivation (server-side, at read time)
// ---------------------------------------------------------------------------

/**
 * Derive one agent's office presence class from raw signals.
 *
 * @param {object} s signals
 * @param {boolean} s.hasHistory      any heartbeat or office event, ever
 * @param {boolean} s.socketLive      a live /ws socket for this agent now
 * @param {number|null} s.lastHeartbeatTs  last channel heartbeat (ms)
 * @param {number|null} s.lastWorkTs  last EVIDENCED office event (ms)
 * @param {number|null} s.lastAnyEventTs   last office event of any tier (ms)
 * @param {boolean} s.sessionOpen     presence.checkin without a later checkout
 * @param {number|null} s.awayUntilTs declared away-until (ms) from presence.away
 * @param {number} now ms epoch
 * @returns {"live"|"awake"|"present_idle"|"away_scheduled"|"in_session"|"stale"|"unknown"}
 *
 * Rules, in order:
 *  1. Declared away and the declaration has not expired -> away_scheduled.
 *     An EXPIRED declaration does not silently close into a work state:
 *     the seat falls through to stale ("overdue") unless newer signals
 *     say otherwise.
 *  2. Evidenced work within the 120s TTL -> live.
 *  3. Any signal within the TTL (heartbeat, any-tier event, live socket):
 *       session open -> in_session; else socket live -> awake;
 *       else -> present_idle.
 *  4. Known before but nothing fresh -> stale.
 *  5. Never seen -> unknown. (Never "absent".)
 */
export function deriveOfficePresence(s, now) {
  if (s.awayUntilTs !== null && s.awayUntilTs !== undefined && s.awayUntilTs > now) {
    return "away_scheduled";
  }
  const fresh = (ts) => typeof ts === "number" && now - ts <= OFFICE_PRESENCE_TTL_MS;
  if (fresh(s.lastWorkTs)) return "live";
  if (fresh(s.lastAnyEventTs) || fresh(s.lastHeartbeatTs) || s.socketLive) {
    if (s.sessionOpen) return "in_session";
    if (s.socketLive) return "awake";
    return "present_idle";
  }
  if (s.hasHistory) return "stale";
  return "unknown";
}
