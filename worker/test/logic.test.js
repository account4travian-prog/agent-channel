/**
 * logic.test.js — node:test suite for worker/src/logic.js (pure functions).
 * Run: npm test   (from worker/)  or: node --test test/
 *
 * Includes NEGATIVE-WITNESS checks per convention: every gate is tested
 * with a deliberately invalid input and the expected refusal is asserted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseMentions,
  isVisibleTo,
  filterVisible,
  alertTargets,
  constantTimeEqual,
  isValidHandle,
  isValidBody,
  isValidRecipient,
  parseCursor,
  parseLimit,
  parseWindowMinutes,
  gateIsOpen,
} from "../src/logic.js";

// --- mention parsing ---------------------------------------------------------

test("parseMentions: basic extraction, deduped, lowercased", () => {
  assert.deepEqual(parseMentions("hey @Atlas and @hark, cc @atlas"), ["atlas", "hark"]);
});

test("parseMentions: no mentions -> []", () => {
  assert.deepEqual(parseMentions("hello world"), []);
});

test("parseMentions: does not match email addresses", () => {
  assert.deepEqual(parseMentions("mail me at jordan@example.com"), []);
});

test("parseMentions: handles with - and _", () => {
  assert.deepEqual(parseMentions("@codex-memory_warden ping"), ["codex-memory_warden"]);
});

test("parseMentions: non-string input -> []", () => {
  assert.deepEqual(parseMentions(null), []);
  assert.deepEqual(parseMentions(42), []);
});

// --- visibility filtering (DM privacy gate) -----------------------------------

test("isVisibleTo: broadcast visible to everyone", () => {
  const msg = { from: "atlas", to: "broadcast" };
  assert.equal(isVisibleTo(msg, "hark"), true);
  assert.equal(isVisibleTo(msg, "stranger"), true);
});

test("isVisibleTo: DM visible to recipient and sender only", () => {
  const msg = { from: "atlas", to: "hark" };
  assert.equal(isVisibleTo(msg, "hark"), true);
  assert.equal(isVisibleTo(msg, "atlas"), true);
});

// NEGATIVE WITNESS: a third party must NOT see someone else's DM.
test("NEGATIVE: third party cannot read a DM between others", () => {
  const msg = { from: "atlas", to: "hark" };
  assert.equal(isVisibleTo(msg, "sol"), false);
  assert.equal(isVisibleTo(msg, ""), false);
  assert.equal(isVisibleTo(msg, "HARK"), false); // case: handles are lowercase
});

test("filterVisible: strips other people's DMs, keeps own", () => {
  const msgs = [
    { from: "atlas", to: "broadcast" },
    { from: "atlas", to: "hark" },
    { from: "sol", to: "atlas" }, // not hark's
    { from: "hark", to: "sol" }, // hark's own sent DM
  ];
  const visible = filterVisible(msgs, "hark");
  assert.equal(visible.length, 3);
  assert.ok(!visible.some((m) => m.from === "sol" && m.to === "atlas"));
});

// --- alert routing targets ----------------------------------------------------

test("alertTargets: mentions + DM recipient, minus sender", () => {
  const msg = { from: "atlas", to: "hark", body: "hi @hark and @sol, cc @atlas" };
  assert.deepEqual(alertTargets(msg).sort(), ["hark", "sol"]);
});

test("alertTargets: broadcast with no mentions -> no targets", () => {
  assert.deepEqual(alertTargets({ from: "a", to: "broadcast", body: "hello all" }), []);
});

// --- constant-time token comparison (auth gate) --------------------------------

test("constantTimeEqual: equal strings -> true", () => {
  assert.equal(constantTimeEqual("abc123", "abc123"), true);
});

// NEGATIVE WITNESS: a wrong token must fail closed (this is the 401 path).
test("NEGATIVE: wrong token fails closed", () => {
  assert.equal(constantTimeEqual("correct-token", "wrong-token!!"), false);
  assert.equal(constantTimeEqual("correct-token", "correct-toke"), false); // length differs
  assert.equal(constantTimeEqual("correct-token", ""), false);
  assert.equal(constantTimeEqual(null, "x"), false);
  assert.equal(constantTimeEqual("x", undefined), false);
});

// --- validation -----------------------------------------------------------------

test("isValidHandle: accepts good, rejects bad", () => {
  assert.equal(isValidHandle("hark"), true);
  assert.equal(isValidHandle("codex-memory_warden"), true);
  assert.equal(isValidHandle("a"), false); // too short
  assert.equal(isValidHandle("Hark"), false); // uppercase
  assert.equal(isValidHandle("-hark"), false); // leading dash
  assert.equal(isValidHandle("ha rk"), false); // space
  assert.equal(isValidHandle("x".repeat(33)), false); // too long
});

test("isValidBody: 4KB cap enforced", () => {
  assert.equal(isValidBody("hello"), true);
  assert.equal(isValidBody("x".repeat(4096)), true);
  assert.equal(isValidBody("x".repeat(4097)), false);
  assert.equal(isValidBody(""), false);
  // multi-byte chars count as UTF-8 bytes, not JS length
  assert.equal(isValidBody("é".repeat(2048)), true); // 4096 bytes exactly
  assert.equal(isValidBody("é".repeat(2049)), false); // 4098 bytes
});

test("isValidRecipient", () => {
  assert.equal(isValidRecipient("broadcast"), true);
  assert.equal(isValidRecipient("hark"), true);
  assert.equal(isValidRecipient("nope!"), false);
});

// --- cursor / pagination ----------------------------------------------------------

test("parseCursor / parseLimit", () => {
  assert.equal(parseCursor("42"), 42);
  assert.equal(parseCursor("abc"), 0);
  assert.equal(parseCursor("-5"), 0);
  assert.equal(parseCursor(null), 0);
  assert.equal(parseLimit("10"), 10);
  assert.equal(parseLimit("9999"), 100); // clamped
  assert.equal(parseLimit("0"), 50); // default
  assert.equal(parseLimit("nope"), 50);
});

// --- registration gate ----------------------------------------------------------

test("parseWindowMinutes: accepts 1..240, rejects the rest", () => {
  assert.equal(parseWindowMinutes(30), 30);
  assert.equal(parseWindowMinutes("60"), 60);
  assert.equal(parseWindowMinutes(1), 1);
  assert.equal(parseWindowMinutes(240), 240);
  assert.equal(parseWindowMinutes(0), null);
  assert.equal(parseWindowMinutes(241), null);
  assert.equal(parseWindowMinutes(-5), null);
  assert.equal(parseWindowMinutes(1.5), null);
  assert.equal(parseWindowMinutes("nope"), null);
  assert.equal(parseWindowMinutes(null), null);
  assert.equal(parseWindowMinutes(undefined), null);
});

test("gateIsOpen: open only while is_open=1 and now < closes_at", () => {
  const now = 1_700_000_000_000;
  assert.equal(gateIsOpen({ is_open: 1, closes_at: now + 60_000 }, now), true);
  // NEGATIVE: expired window is closed (the auto-expiry enforcement path)
  assert.equal(gateIsOpen({ is_open: 1, closes_at: now - 1 }, now), false);
  assert.equal(gateIsOpen({ is_open: 1, closes_at: now }, now), false); // boundary
  // NEGATIVE: explicitly closed gate
  assert.equal(gateIsOpen({ is_open: 0, closes_at: now + 60_000 }, now), false);
  // NEGATIVE: malformed rows fail closed
  assert.equal(gateIsOpen(null, now), false);
  assert.equal(gateIsOpen({ is_open: 1, closes_at: null }, now), false);
  assert.equal(gateIsOpen({ is_open: 1 }, now), false);
});
