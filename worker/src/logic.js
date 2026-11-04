/**
 * logic.js — pure, dependency-free functions for the Agent Channel.
 *
 * Kept free of Workers APIs on purpose so the same code runs under
 * node:test. room.js imports from here; nothing here may touch
 * `Request`, `Response`, `crypto.subtle` (async), or Durable Objects.
 */

// ---------------------------------------------------------------------------
// Mention parsing
// ---------------------------------------------------------------------------

// Matches @handle mentions. Handles: 2-32 chars, [a-z0-9_-], must start
// with a letter or digit. The \B guard avoids matching email addresses
// (user@example.com) while still matching "@handle" at string start.
const MENTION_RE = /\B@([a-z0-9][a-z0-9_-]{1,31})/gi;

/**
 * Extract unique lowercase @handles mentioned in a message body.
 * @param {string} body
 * @returns {string[]} unique handles, lowercase, in order of appearance
 */
export function parseMentions(body) {
  if (typeof body !== "string") return [];
  const seen = new Set();
  const out = [];
  // Fresh regex per call: the /g flag makes .exec stateful.
  const re = new RegExp(MENTION_RE.source, MENTION_RE.flags);
  let m;
  while ((m = re.exec(body)) !== null) {
    const h = m[1].toLowerCase();
    if (!seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Visibility filtering (server-side DM privacy)
// ---------------------------------------------------------------------------

/**
 * Is message `msg` visible to `callerHandle`?
 * - broadcast: everyone
 * - DM: only the sender and the recipient
 * @param {{from:string,to:string}} msg
 * @param {string} callerHandle lowercase
 * @returns {boolean}
 */
export function isVisibleTo(msg, callerHandle) {
  if (!msg || !callerHandle) return false;
  if (msg.to === "broadcast") return true;
  return msg.to === callerHandle || msg.from === callerHandle;
}

/**
 * Filter a list of messages to the caller's visible set.
 * @param {Array<{from:string,to:string}>} msgs
 * @param {string} callerHandle lowercase
 */
export function filterVisible(msgs, callerHandle) {
  return (msgs || []).filter((m) => isVisibleTo(m, callerHandle));
}

// ---------------------------------------------------------------------------
// Alert routing targets
// ---------------------------------------------------------------------------

/**
 * Compute the set of handles that must be alerted for a message:
 * explicit DM recipient (to-field) plus all @mentions, minus the sender.
 * @param {{from:string,to:string,body:string}} msg
 * @returns {string[]} unique lowercase handles
 */
export function alertTargets(msg) {
  const targets = new Set(parseMentions(msg.body));
  if (msg.to && msg.to !== "broadcast") targets.add(msg.to.toLowerCase());
  targets.delete((msg.from || "").toLowerCase());
  return [...targets];
}

// ---------------------------------------------------------------------------
// Constant-time string comparison (token auth without timingSafeEqual)
// ---------------------------------------------------------------------------

/**
 * Compare two strings in constant time relative to max length.
 * Returns false if lengths differ (length itself is not secret here —
 * all our tokens/hashes are fixed length, so this is safe).
 * @param {string} a
 * @param {string} b
 */
export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/** Valid agent handle: 2-32 chars, lowercase alnum/_/-, starts alnum. */
export function isValidHandle(h) {
  return typeof h === "string" && HANDLE_RE.test(h);
}

export const MAX_BODY_BYTES = 4096;

/** Body must be a non-empty string within the 4KB cap (UTF-8 bytes). */
export function isValidBody(body) {
  if (typeof body !== "string" || body.length === 0) return false;
  // TextEncoder is available in both Workers and Node 24.
  return new TextEncoder().encode(body).length <= MAX_BODY_BYTES;
}

/** Recipient: "broadcast" or a valid handle. */
export function isValidRecipient(to) {
  return to === "broadcast" || isValidHandle(to);
}

// ---------------------------------------------------------------------------
// Cursor / pagination
// ---------------------------------------------------------------------------

/** Normalize ?since= to a non-negative integer cursor. */
export function parseCursor(raw) {
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** Normalize ?limit= to 1..100, default 50. */
export function parseLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n < 1) return 50;
  return Math.min(n, 100);
}

/** 30-day message TTL in milliseconds. */
export const MESSAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Registration gate
// ---------------------------------------------------------------------------

export const GATE_WINDOW_MIN = 1;
export const GATE_WINDOW_MAX = 240;
export const GATE_WINDOW_DEFAULT_MIN = 30;

/**
 * Validate an open-window duration: integer minutes, 1..240. Else null.
 * @param {unknown} raw
 * @returns {number|null}
 */
export function parseWindowMinutes(raw) {
  const n = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n)) return null;
  if (n < GATE_WINDOW_MIN || n > GATE_WINDOW_MAX) return null;
  return n;
}

/**
 * Pure predicate: is the registration gate open right now?
 * row = {is_open: 0|1, closes_at: number|null}, now = ms epoch.
 * Expiry is enforced by the caller (room.js lazily closes on read).
 * @param {{is_open:number, closes_at:number|null}|null} row
 * @param {number} now
 * @returns {boolean}
 */
export function gateIsOpen(row, now) {
  if (!row || row.is_open !== 1) return false;
  if (typeof row.closes_at !== "number") return false;
  return now < row.closes_at;
}
