/**
 * channel.test.js — integration tests against the real Worker + RoomObject
 * Durable Object running in the Workers runtime (vitest-pool-workers).
 *
 * Run: npx vitest --run   (from worker/)
 *
 * NEGATIVE-WITNESS checks: bad owner token -> 403, bad agent token -> 401,
 * third party cannot read someone else's DM, unknown DM recipient -> 422.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";

const OWNER = "test-owner-token-do-not-use-in-prod";
const GATE = "test-gate-key-do-not-use-in-prod";
const BASE = "https://agents.test";

const ownerHeaders = { "X-Owner-Token": OWNER, "content-type": "application/json" };
const gateHeaders = { "X-Gate-Key": GATE, "content-type": "application/json" };
const jsonHeaders = { "content-type": "application/json" };
const agentHeaders = (t) => ({ Authorization: `Bearer ${t}`, "content-type": "application/json" });

async function register(handle, displayName) {
  const res = await SELF.fetch(
    `${BASE}/api/agents/register`,
    {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ handle, displayName }),
    }
  );
  return res;
}

let atlasToken, harkToken, solToken;

beforeAll(async () => {
  for (const [h, name] of [["atlas", "Atlas"], ["hark", "Hark"], ["sol", "Sol"]]) {
    const res = await register(h, name);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(typeof data.token).toBe("string");
    expect(data.token.length).toBeGreaterThan(32);
    if (h === "atlas") atlasToken = data.token;
    if (h === "hark") harkToken = data.token;
    if (h === "sol") solToken = data.token;
  }
});

describe("owner auth (NEGATIVE WITNESSES)", () => {
  it("rejects registration with a wrong owner token -> 403", async () => {
    const res = await SELF.fetch(`${BASE}/api/agents/register`, {
      method: "POST",
      headers: { "X-Owner-Token": "wrong-token", "content-type": "application/json" },
      body: JSON.stringify({ handle: "mallory", displayName: "Mallory" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects registration with no owner token -> 403", async () => {
    const res = await SELF.fetch(`${BASE}/api/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "mallory", displayName: "Mallory" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects duplicate handle -> 409", async () => {
    const res = await register("atlas", "Atlas Again");
    expect(res.status).toBe(409);
  });

  it("rejects invalid handle -> 422", async () => {
    const res = await SELF.fetch(`${BASE}/api/agents/register`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ handle: "BAD HANDLE!", displayName: "x" }),
    });
    expect(res.status).toBe(422);
  });
});

describe("agent auth (NEGATIVE WITNESSES)", () => {
  it("rejects posting with a bad bearer token -> 401", async () => {
    const res = await SELF.fetch(`${BASE}/api/messages`, {
      method: "POST",
      headers: agentHeaders("this-is-not-a-real-token"),
      body: JSON.stringify({ to: "broadcast", body: "hello" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects posting with no token -> 401", async () => {
    const res = await SELF.fetch(`${BASE}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "broadcast", body: "hello" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("messaging + DM privacy", () => {
  it("atlas DMs hark -> 201 with id", async () => {
    const res = await SELF.fetch(`${BASE}/api/messages`, {
      method: "POST",
      headers: agentHeaders(atlasToken),
      body: JSON.stringify({ to: "hark", body: "secret plans @hark" }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(typeof data.id).toBe("number");
  });

  it("hark can read the DM", async () => {
    const res = await SELF.fetch(`${BASE}/api/messages?since=0`, {
      headers: { Authorization: `Bearer ${harkToken}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const dm = data.messages.find((m) => m.to === "hark" && m.from === "atlas");
    expect(dm).toBeDefined();
    expect(dm.body).toContain("secret plans");
  });

  // NEGATIVE WITNESS: sol must NOT see atlas->hark DM at the HTTP level.
  it("NEGATIVE: third party cannot read the DM", async () => {
    const res = await SELF.fetch(`${BASE}/api/messages?since=0`, {
      headers: { Authorization: `Bearer ${solToken}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.messages.some((m) => m.to === "hark" && m.from === "atlas")).toBe(false);
  });

  it("rejects DM to unknown handle -> 422", async () => {
    const res = await SELF.fetch(`${BASE}/api/messages`, {
      method: "POST",
      headers: agentHeaders(atlasToken),
      body: JSON.stringify({ to: "ghost", body: "hello?" }),
    });
    expect(res.status).toBe(422);
  });

  it("rejects oversized body -> 413", async () => {
    const res = await SELF.fetch(`${BASE}/api/messages`, {
      method: "POST",
      headers: agentHeaders(atlasToken),
      body: JSON.stringify({ to: "broadcast", body: "x".repeat(5000) }),
    });
    expect(res.status).toBe(413);
  });

  it("cursor pagination works", async () => {
    const r1 = await SELF.fetch(`${BASE}/api/messages?since=0&limit=1`, {
      headers: { Authorization: `Bearer ${atlasToken}` },
    });
    const d1 = await r1.json();
    expect(d1.messages.length).toBe(1);
    const r2 = await SELF.fetch(`${BASE}/api/messages?since=${d1.lastSeq}`, {
      headers: { Authorization: `Bearer ${atlasToken}` },
    });
    const d2 = await r2.json();
    expect(d2.messages.every((m) => m.seq > d1.lastSeq)).toBe(true);
  });

  it("idempotent retry with same clientMsgId returns original", async () => {
    const payload = { to: "broadcast", body: "retry me", clientMsgId: "idem-1" };
    const r1 = await SELF.fetch(`${BASE}/api/messages`, {
      method: "POST",
      headers: agentHeaders(solToken),
      body: JSON.stringify(payload),
    });
    const d1 = await r1.json();
    const r2 = await SELF.fetch(`${BASE}/api/messages`, {
      method: "POST",
      headers: agentHeaders(solToken),
      body: JSON.stringify(payload),
    });
    const d2 = await r2.json();
    expect(r2.status).toBe(201);
    expect(d2.id).toBe(d1.id);
    expect(d2.duplicate).toBe(true);
  });

  it("same clientMsgId with different bytes -> 409 conflict", async () => {
    const r = await SELF.fetch(`${BASE}/api/messages`, {
      method: "POST",
      headers: agentHeaders(solToken),
      body: JSON.stringify({ to: "broadcast", body: "different!", clientMsgId: "idem-1" }),
    });
    expect(r.status).toBe(409);
  });
});

describe("presence + webhooks + health", () => {
  it("heartbeat then presence shows the seat", async () => {
    const hb = await SELF.fetch(`${BASE}/api/heartbeat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${atlasToken}` },
    });
    expect(hb.status).toBe(200);
    const pr = await SELF.fetch(`${BASE}/api/presence`, {
      headers: { Authorization: `Bearer ${atlasToken}` },
    });
    const data = await pr.json();
    expect(data.presence.some((p) => p.handle === "atlas")).toBe(true);
  });

  it("webhook register validates URL scheme", async () => {
    const bad = await SELF.fetch(`${BASE}/api/webhooks`, {
      method: "POST",
      headers: agentHeaders(harkToken),
      body: JSON.stringify({ url: "http://insecure.example/hook", secret: "a-very-long-secret-value" }),
    });
    expect(bad.status).toBe(422);
    const good = await SELF.fetch(`${BASE}/api/webhooks`, {
      method: "POST",
      headers: agentHeaders(harkToken),
      body: JSON.stringify({ url: "https://hark.example/hook", secret: "a-very-long-secret-value" }),
    });
    expect(good.status).toBe(200);
    const del = await SELF.fetch(`${BASE}/api/webhooks`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${harkToken}` },
    });
    expect(del.status).toBe(200);
  });

  it("health is unauthenticated and reports quota state", async () => {
    const res = await SELF.fetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(typeof data.requestsToday).toBe("number");
    expect(data.shedding).toBe(false);
  });

  it("rate limit trips after 60 req/min per token", async () => {
    let limited = 0;
    for (let i = 0; i < 65; i++) {
      const res = await SELF.fetch(`${BASE}/api/heartbeat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${solToken}` },
      });
      if (res.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  }, 30000);
});

describe("revoke", () => {
  it("owner revokes a seat; its token 401s afterwards", async () => {
    const reg = await register("temp", "Temp");
    expect(reg.status).toBe(201);
    const { token } = await reg.json();
    const rev = await SELF.fetch(`${BASE}/api/agents/revoke`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ handle: "temp" }),
    });
    expect(rev.status).toBe(200);
    const post = await SELF.fetch(`${BASE}/api/messages`, {
      method: "POST",
      headers: agentHeaders(token),
      body: JSON.stringify({ to: "broadcast", body: "am i still here" }),
    });
    expect(post.status).toBe(401);
  });
});

describe("registration gate", () => {
  const toggle = (key, payload) =>
    SELF.fetch(`${BASE}/api/admin/registration`, {
      method: "POST",
      headers: key ? { "X-Gate-Key": key, "content-type": "application/json" } : jsonHeaders,
      body: JSON.stringify(payload),
    });
  const publicRegister = (handle, displayName) =>
    SELF.fetch(`${BASE}/api/agents/register`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ handle, displayName }),
    });
  const gateStatus = () => SELF.fetch(`${BASE}/api/admin/registration`);

  it("gate is closed by default -> public register 403 registration_closed", async () => {
    const st = await (await gateStatus()).json();
    expect(st.open).toBe(false);
    const res = await publicRegister("gate-newbie", "Gate Newbie");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("registration_closed");
  });

  it("NEGATIVE: toggle with missing/wrong gate key -> 403", async () => {
    const noKey = await toggle(null, { action: "open" });
    expect(noKey.status).toBe(403);
    const wrongKey = await toggle("not-the-gate-key", { action: "open" });
    expect(wrongKey.status).toBe(403);
    // gate must still be closed after the failed attempts
    expect((await (await gateStatus()).json()).open).toBe(false);
  });

  it("NEGATIVE: bad windowMinutes -> 422; bad action -> 400", async () => {
    const badWindow = await toggle(GATE, { action: "open", windowMinutes: 999 });
    expect(badWindow.status).toBe(422);
    const badAction = await toggle(GATE, { action: "explode" });
    expect(badAction.status).toBe(400);
  });

  it("open with the gate key -> 200, gate status public", async () => {
    const before = Date.now();
    const res = await toggle(GATE, { action: "open", windowMinutes: 30 });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.open).toBe(true);
    expect(data.closesAt).toBeGreaterThan(before);
    const st = await (await gateStatus()).json(); // no auth
    expect(st.open).toBe(true);
    expect(st.closesAt).toBe(data.closesAt);
    // Landing page renders the registration form while the gate is open.
    const page = await SELF.fetch(`${BASE}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('id="reg"');
    expect(html).toContain("/api/agents/register");
  });

  let claimCode;
  it("public register while open -> 201 pending, claim code shown once", async () => {
    const res = await publicRegister("gate-newbie", "Gate Newbie");
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.status).toBe("pending");
    expect(data.handle).toBe("gate-newbie");
    expect(typeof data.claimCode).toBe("string");
    expect(data.claimCode).toMatch(/^[0-9a-f]{64}$/);
    claimCode = data.claimCode;
  });

  it("duplicate handle while pending -> 409", async () => {
    const res = await publicRegister("gate-newbie", "Someone Else");
    expect(res.status).toBe(409);
  });

  it("NEGATIVE: pending seat's claim code is not a bearer token -> 401", async () => {
    const res = await SELF.fetch(`${BASE}/api/messages`, {
      method: "POST",
      headers: agentHeaders(claimCode),
      body: JSON.stringify({ to: "broadcast", body: "let me in" }),
    });
    expect(res.status).toBe(401);
  });

  it("claim while pending -> 202 still waiting", async () => {
    const res = await SELF.fetch(`${BASE}/api/agents/claim`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ handle: "gate-newbie", claimCode }),
    });
    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe("pending");
  });

  it("NEGATIVE: wrong claim code -> 401; unknown handle -> 401", async () => {
    const wrong = await SELF.fetch(`${BASE}/api/agents/claim`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ handle: "gate-newbie", claimCode: "0".repeat(64) }),
    });
    expect(wrong.status).toBe(401);
    const unknown = await SELF.fetch(`${BASE}/api/agents/claim`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ handle: "gate-nobody", claimCode }),
    });
    expect(unknown.status).toBe(401);
  });

  it("owner approves -> active; claim mints the token ONCE", async () => {
    const appr = await SELF.fetch(`${BASE}/api/agents/approve`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ handle: "gate-newbie" }),
    });
    expect(appr.status).toBe(200);
    expect((await appr.json()).status).toBe("active");

    const claim = await SELF.fetch(`${BASE}/api/agents/claim`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ handle: "gate-newbie", claimCode }),
    });
    expect(claim.status).toBe(200);
    const data = await claim.json();
    expect(typeof data.token).toBe("string");
    expect(data.token.length).toBeGreaterThan(32);

    // The claimed token authenticates and posts.
    const post = await SELF.fetch(`${BASE}/api/messages`, {
      method: "POST",
      headers: agentHeaders(data.token),
      body: JSON.stringify({ to: "broadcast", body: "gate-newbie is live" }),
    });
    expect(post.status).toBe(201);

    // Second claim with the same code -> 410 gone.
    const again = await SELF.fetch(`${BASE}/api/agents/claim`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ handle: "gate-newbie", claimCode }),
    });
    expect(again.status).toBe(410);
  });

  it("duplicate handle once active -> 409", async () => {
    const res = await publicRegister("gate-newbie", "Impostor");
    expect(res.status).toBe(409);
  });

  it("owner approve/reject require owner token -> 403 without", async () => {
    const appr = await SELF.fetch(`${BASE}/api/agents/approve`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ handle: "gate-newbie" }),
    });
    expect(appr.status).toBe(403);
    const rej = await SELF.fetch(`${BASE}/api/agents/reject`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ handle: "gate-newbie" }),
    });
    expect(rej.status).toBe(403);
  });

  it("reject deletes a pending seat; the handle becomes reusable", async () => {
    const reg = await publicRegister("gate-rejectme", "Reject Me");
    expect(reg.status).toBe(201);
    const rej = await SELF.fetch(`${BASE}/api/agents/reject`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ handle: "gate-rejectme" }),
    });
    expect(rej.status).toBe(200);
    const rere = await publicRegister("gate-rejectme", "Second Chance");
    expect(rere.status).toBe(201);
    expect((await rere.json()).status).toBe("pending");
  });

  it("owner-token register path still creates an immediately-active seat", async () => {
    const res = await register("gate-direct", "Gate Direct");
    expect(res.status).toBe(201);
    const { token } = await res.json();
    const post = await SELF.fetch(`${BASE}/api/messages`, {
      method: "POST",
      headers: agentHeaders(token),
      body: JSON.stringify({ to: "broadcast", body: "direct seat works" }),
    });
    expect(post.status).toBe(201);
  });

  it("revoking a pending seat deletes it (cannot be approved/claimed after)", async () => {
    const reg = await publicRegister("gate-doomed", "Doomed");
    expect(reg.status).toBe(201);
    const { claimCode: doomedCode } = await reg.json();
    const rev = await SELF.fetch(`${BASE}/api/agents/revoke`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ handle: "gate-doomed" }),
    });
    expect(rev.status).toBe(200);
    // approve now fails: the seat is gone
    const appr = await SELF.fetch(`${BASE}/api/agents/approve`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ handle: "gate-doomed" }),
    });
    expect(appr.status).toBe(404);
    // claim with the old code fails: indistinguishable 401
    const claim = await SELF.fetch(`${BASE}/api/agents/claim`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ handle: "gate-doomed", claimCode: doomedCode }),
    });
    expect(claim.status).toBe(401);
  });

  it("close the gate -> public register 403 again; landing page says closed", async () => {
    const res = await toggle(GATE, { action: "close" });
    expect(res.status).toBe(200);
    expect((await res.json()).open).toBe(false);
    const reg = await publicRegister("gate-late", "Too Late");
    expect(reg.status).toBe(403);
    const page = await SELF.fetch(`${BASE}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("Registration is <strong>closed</strong>");
  });
});

describe("mentions endpoint (wake-on-schedule seats)", () => {
  let wakerToken, sleeperToken;
  async function mentions(token, since = 0) {
    const res = await SELF.fetch(`${BASE}/api/mentions?since=${since}`, {
      headers: agentHeaders(token),
    });
    expect(res.status).toBe(200);
    return res.json();
  }
  async function post(token, to, body) {
    const res = await SELF.fetch(`${BASE}/api/messages`, {
      method: "POST",
      headers: agentHeaders(token),
      body: JSON.stringify({ to, body }),
    });
    expect(res.status).toBe(201);
    return res.json();
  }

  it("returns @-mentions and DMs only, per seat", async () => {
    // Fresh seats: the 60 req/min per-token bucket is shared across the
    // whole suite, so this block gets its own tokens.
    for (const [h, v] of [["waker", "wakerToken"], ["sleeper", "sleeperToken"]]) {
      const reg = await register(h, h);
      expect(reg.status).toBe(201);
      const { token } = await reg.json();
      if (v === "wakerToken") wakerToken = token; else sleeperToken = token;
    }
    const w0 = await mentions(wakerToken);
    const startSeq = w0.lastSeq;
    await post(sleeperToken, "broadcast", "@waker ping from the mentions test");
    await post(sleeperToken, "waker", "a direct line for waker");
    await post(sleeperToken, "broadcast", "nothing for anyone in particular");

    const wm = await mentions(wakerToken, startSeq);
    expect(wm.mentions.length).toBe(2);
    expect(wm.mentions[0].kind).toBe("mention");
    expect(wm.mentions[0].from).toBe("sleeper");
    expect(wm.mentions[1].kind).toBe("dm");
    // cursor advanced past the non-mention too
    expect(wm.lastSeq).toBeGreaterThan(wm.mentions[1].seq);

    const am = await mentions(atlasToken, startSeq);
    expect(am.mentions.length).toBe(0);
  });

  it("excludes your own messages and requires auth", async () => {
    const w0 = await mentions(wakerToken);
    await post(wakerToken, "broadcast", "@waker talking to myself");
    const wm = await mentions(wakerToken, w0.lastSeq);
    expect(wm.mentions.length).toBe(0);

    const noAuth = await SELF.fetch(`${BASE}/api/mentions?since=0`);
    expect(noAuth.status).toBe(401);
    const bad = await SELF.fetch(`${BASE}/api/mentions?since=0`, {
      headers: agentHeaders("bogus-token"),
    });
    expect(bad.status).toBe(401);
  });
});

describe("self-contained onboarding", () => {
  const toggle = (key, payload) =>
    SELF.fetch(`${BASE}/api/admin/registration`, {
      method: "POST",
      headers: key ? { "X-Gate-Key": key, "content-type": "application/json" } : jsonHeaders,
      body: JSON.stringify(payload),
    });

  it("GET /api/docs is public and describes the whole service", async () => {
    const res = await SELF.fetch(`${BASE}/api/docs`);
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.ok).toBe(true);
    expect(d.service).toBe("agent-channel");
    expect(Array.isArray(d.endpoints)).toBe(true);
    const paths = d.endpoints.map((e) => `${e.method} ${e.path}`);
    for (const p of ["GET /api/mentions?since=<seq>&limit=50", "GET /api/whoami", "POST /api/messages"]) {
      expect(paths).toContain(p);
    }
    expect(Array.isArray(d.onboarding)).toBe(true);
    expect(d.onboarding.length).toBeGreaterThanOrEqual(3);
    expect(d.daemon.files.length).toBe(4);
  });

  it("GET /api/whoami verifies a token; 401 without one", async () => {
    const noAuth = await SELF.fetch(`${BASE}/api/whoami`);
    expect(noAuth.status).toBe(401);
    const bad = await SELF.fetch(`${BASE}/api/whoami`, { headers: agentHeaders("bogus") });
    expect(bad.status).toBe(401);

    const reg = await register("whoami-seat", "Whoami");
    expect(reg.status).toBe(201);
    const { token } = await reg.json();
    const me = await SELF.fetch(`${BASE}/api/whoami`, { headers: agentHeaders(token) });
    expect(me.status).toBe(200);
    const d = await me.json();
    expect(d.handle).toBe("whoami-seat");
    expect(d.docs).toContain("/api/docs");
    expect(d.guide).toContain("/#start");
  });

  it("public register -> approve -> claim returns docs links; landing page teaches", async () => {
    const open = await toggle(GATE, { action: "open", windowMinutes: 5 });
    expect(open.status).toBe(200);
    const reg = await SELF.fetch(`${BASE}/api/agents/register`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ handle: "onboard-me", displayName: "Onboard" }),
    });
    expect(reg.status).toBe(201);
    const { claimCode } = await reg.json();
    expect(typeof claimCode).toBe("string");

    const appr = await SELF.fetch(`${BASE}/api/agents/approve`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ handle: "onboard-me" }),
    });
    expect(appr.status).toBe(200);

    const claim = await SELF.fetch(`${BASE}/api/agents/claim`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ handle: "onboard-me", claimCode }),
    });
    expect(claim.status).toBe(200);
    const cd = await claim.json();
    expect(cd.ok).toBe(true);
    expect(typeof cd.token).toBe("string");
    expect(cd.docs).toContain("/api/docs");
    expect(cd.guide).toContain("/#start");
    expect(cd.whoami).toContain("/api/whoami");

    // The landing page is a self-contained guide while the gate is open.
    const page = await SELF.fetch(`${BASE}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('id="start"');
    expect(html).toContain("/api/docs");
    expect(html).toContain("claim code");
    expect(html).toContain('id="reg"');

    const close = await toggle(GATE, { action: "close" });
    expect(close.status).toBe(200);
  });
});
