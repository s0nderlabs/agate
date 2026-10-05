// The pretend server answers like server/API.md, so the screens built on it keep working when the transport becomes a
// real fetch. Run with `bun test src/lib/account`.
import { describe, expect, test } from "bun:test";
import { serverApi, ServerError } from "./api";
import { activityLine, approvalWhat, grantState, spentOf, tradesIn24h } from "./aiView";
import { fakeTransport, fakeWorld, NOT_YET_ANSWERS } from "./fakeServer";

const MAIN = "0xF77c3a91d2b8e4c05f1a8e2d9b7c4a10e3d96b70";
const api = (scenario: "none" | "one" | "two" | "ended", connect: "normal" | "notyet" | "refused" = "normal") => {
  const world = () => fakeWorld({ scenario, main: `${MAIN}${scenario}${connect}`.slice(0, 42), email: "you@example.com", connect, disc: "normal" });
  return { api: serverApi(fakeTransport(world)), world };
};

describe("fake server", () => {
  test("one AI: /api/me gives the next pocket index and the grant", async () => {
    const { api: a } = api("one");
    const me = await a.me();
    expect(me.grants.length).toBe(1);
    expect(me.nextPocketIndex).toBe(2);
    expect(me.grants[0].budget).toBe("1000000000");
    expect(grantState(me.grants[0])).toBe("active");
  });

  test("activity: spent and trades in the last 24 hours come from the trade summaries", async () => {
    const { api: a } = api("one");
    const events = await a.activity({ grantId: "g-claude" });
    expect(spentOf("g-claude", events)).toBe(258);
    expect(tradesIn24h("g-claude", events)).toBe(2);
    const refused = events.find((e) => e.name === "pocket.refused")!;
    expect(activityLine(refused, "Claude")?.text).toContain("more than its limit on one trade");
  });

  test("activity reads like the server's: the trade summary nested, a roll counted once, never shown twice", async () => {
    const { api: a } = api("two");
    const events = await a.activity({ grantId: "g-claude" });
    const t = events.find((e) => e.name === "pocket.trade" && (e.detail.summary as { gpu?: string }).gpu === "H200")!;
    expect(t.detail.action).toBeUndefined();
    expect(activityLine(t, "Claude")).toMatchObject({ text: "Long H200 November", amount: 108 });
    expect(spentOf("g-claude", events)).toBe(258);
    // two trades and one autopilot roll, as the server counts pocket.trade
    expect(tradesIn24h("g-claude", events)).toBe(3);
    const lines = events.map((e) => activityLine(e, "Claude")).filter(Boolean);
    expect(lines.filter((l) => /Long into|Keep my hedge going, H100: /.test(l!.text)).length).toBe(1);
  });

  test("approvals carry the server's over-cap summaries: a Short's collateral, a Long's dollars", async () => {
    const { api: a } = api("two");
    const list = await a.approvals();
    const short = list.find((x) => x.id === "a-short")!;
    expect(short.summary).toMatchObject({ action: "open_short", collateral: 800, runFrom: "main" });
    expect(approvalWhat(short)).toMatchObject({ dollars: 800, what: "Short H100 November, 100 GPU-hours ($800 up front)" });
    expect(list.find((x) => x.id === "a-close")!.summary).toMatchObject({ action: "close_short", maxDollars: 310, runFrom: "pocket" });
    const events = await a.activity({ grantId: "g-chatgpt" });
    expect(activityLine(events.find((e) => e.name === "approval.requested")!, "ChatGPT")).toMatchObject({ text: "ChatGPT asked to go over its limit: Short H100 November.", amount: 800 });
  });

  test("/api/me lists only delegated keys; a grant must name this person's Assistant", async () => {
    const { api: a, world } = api("none");
    world().assistant = "0x00000000000000000000000000000000000000a5";
    expect((await a.me()).delegations).toEqual([]);
    const err = await a.createGrant({ label: "X", mainOwner: MAIN, assistantAddress: "", budget: "1", perTradeCap: "1", tradesPerDay: 1, validUntil: 1, pocketIndex: 1, approval: "x" }).catch((e) => e);
    expect((err as ServerError).status).toBe(409);
  });

  test("a grant is created at the asked pocket, and a 409 while the key is not delegated", async () => {
    const { api: a, world } = api("one");
    const bad = await a.createGrant({ label: "Cursor", mainOwner: MAIN, assistantAddress: "", budget: "500000000", perTradeCap: "100000000", tradesPerDay: 3, validUntil: Math.floor(Date.now() / 1000) + 86_400, pocketIndex: 2, approval: "x" }).catch((e) => e);
    expect((bad as ServerError).status).toBe(403);
    const g = await a.createGrant({ label: "Cursor", mainOwner: MAIN, assistantAddress: world().assistant!, budget: "500000000", perTradeCap: "100000000", tradesPerDay: 3, validUntil: Math.floor(Date.now() / 1000) + 86_400, pocketIndex: 2, approval: "x" });
    expect(g.pocketIndex).toBe(2);
    expect(g.status).toBe("active");
    const { api: b } = api("one", "notyet");
    const err = await b.createGrant({ label: "X", mainOwner: MAIN, assistantAddress: "0x1", budget: "1", perTradeCap: "1", tradesPerDay: 1, validUntil: 1, pocketIndex: 2, approval: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect((err as ServerError).problem.kind).toBe("notYet");
  });

  test("OAuth: a request reads, a deny redirects with access_denied, then it is gone", async () => {
    const { api: a } = api("one");
    const r = await a.oauthRequest("abc");
    expect(r.clientName).toBe("Claude");
    expect(r.redirectHost).toBe("claude.ai");
    const d = await a.oauthDeny("abc");
    expect(d.redirect).toContain("error=access_denied");
    const again = await a.oauthRequest("abc").catch((e) => e);
    expect((again as ServerError).problem.kind).toBe("notFound");
  });

  test("approvals: an expired one refuses deny with 409; a pending one reads as Long H100 November, $600", async () => {
    const { api: a } = api("one");
    const list = await a.approvals();
    const pending = list.find((x) => x.id === "a-long")!;
    expect(approvalWhat(pending).what).toBe("Long H100 November, $600");
    const err = await a.approvalDeny("a-old").catch((e) => e);
    expect((err as ServerError).problem.kind).toBe("approvalEnded");
    const done = await a.approvalDeny("a-long");
    expect(done.status).toBe("denied");
  });

  test("standing orders: start once per GPU, stop", async () => {
    const { api: a } = api("one");
    const o = await a.startStandingOrder({ grantId: "g-claude", gpu: "H200" });
    expect(o.status).toBe("active");
    const same = await a.startStandingOrder({ grantId: "g-claude", gpu: "H200" });
    expect(same.id).toBe(o.id);
    const stopped = await a.stopStandingOrder(o.id);
    expect(stopped.status).toBe("stopped");
  });

  test("Key not there yet: 409 long enough for the app's patience, then Try again goes through", async () => {
    const { api: a, world } = api("one", "notyet");
    const ask = () => a.createGrant({ label: "Cursor", mainOwner: MAIN, assistantAddress: world().assistant!, budget: "500000000", perTradeCap: "100000000", tradesPerDay: 3, validUntil: Math.floor(Date.now() / 1000) + 86_400, pocketIndex: 7, approval: "x" });
    for (let i = 0; i < NOT_YET_ANSWERS; i++) expect(((await ask().catch((e) => e)) as ServerError).problem.kind).toBe("notYet");
    expect((await ask()).status).toBe("active");
  });

  test("a disconnect ends the AI's requests still waiting: none can be approved after", async () => {
    const { api: a } = api("two");
    expect((await a.approvals()).find((x) => x.id === "a-short")!.status).toBe("pending");
    await a.disconnect("g-chatgpt");
    expect((await a.approvals()).find((x) => x.id === "a-short")!.status).toBe("expired");
    // Claude's own requests are untouched
    expect((await a.approvals()).find((x) => x.id === "a-long")!.status).toBe("pending");
    const err = await a.approvalDeny("a-short").catch((e) => e);
    expect((err as ServerError).problem.kind).toBe("approvalEnded");
  });

  test("ended: one expired, one disconnected", async () => {
    const { api: a } = api("ended");
    const grants = await a.grants();
    expect(grants.map((g) => grantState(g)).sort()).toEqual(["disconnected", "ended"]);
  });
});
