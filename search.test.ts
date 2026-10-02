import { describe, expect, test } from "bun:test";
import { type ImsgMessage } from "./collector";
import { shapeResults, runSearch } from "./search";

const message = (fields: Partial<ImsgMessage>): ImsgMessage => ({
  id: 1, chat: "chat123", handle: "+15551234567", name: "Example",
  ts: "2026-09-01T12:00:00Z", text: "yes", from_me: false, service: "iMessage",
  ...fields,
});

describe("search self echoes", () => {
  test("keeps an outgoing group reply and another member's identical reply", () => {
    const rows = [
      message({ id: 1, from_me: true }),
      message({ id: 2, handle: "+15557654321" }),
    ];
    for (const order of [rows, [...rows].reverse()]) {
      const hits = shapeResults(order, "yes", 10);
      expect(hits).toHaveLength(2);
      expect(hits.map(hit => hit.handle).sort()).toEqual(["+15551234567", "+15557654321"]);
    }
  });

  test("attributes a self echo to me regardless of bridge row order", () => {
    const rows = [
      message({ id: 1, chat: "+15551234567", from_me: true }),
      message({ id: 2, chat: "+15551234567" }),
    ];
    for (const order of [rows, [...rows].reverse()]) {
      const hits = shapeResults(order, "yes", 10);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.from_me).toBe(true);
    }
  });

  test("a decoded incoming self echo inherits an empty outgoing row", () => {
    const hits = shapeResults([
      message({ id: 1, chat: "+15551234567", text: "", from_me: true }),
      message({ id: 2, chat: "+15551234567" }),
    ], "yes", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.from_me).toBe(true);
    expect(hits[0]!.text).toBe("yes");
  });

  test("search runner preserves both group hits through shaping and limiting", () => {
    const rows = [message({ id: 1, from_me: true }), message({ id: 2, handle: "+15557654321" })];
    const runner = ((_cmd: string, args: string[], options: { input: string }) => {
      expect(args).not.toContain("yes");
      expect(options.input).toBe("yes");
      return { status: 0, stdout: JSON.stringify(rows), stderr: "" };
    }) as never;
    const result = runSearch("yes", 2, runner);
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(2);
  });
});
