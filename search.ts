#!/usr/bin/env bun
/**
 * Blip search — conversations by name, then full-text messages.
 *
 *   bun search.ts <query> [limit]   →  {ok, online, error, results}
 *
 * Message hits come from `imsg search` (LIKE over text + attributedBody
 * bytes on the Mac). Conversation hits are matched in-process against the
 * sidebar thread list (name/handle/chat id only; never message bodies).
 */

import { shimPath } from "./shim-path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { chatKey, dedupeSelfEcho, isGroupChat, type ImsgMessage } from "./collector";
import { fuzzyScore } from "./contact-search";

const HOME = process.env.HOME ?? homedir();

export interface SearchHit {
  chat: string;
  name: string;
  handle: string;
  service: string;
  ts: string;
  from_me: boolean;
  text: string;
  group: boolean;
  /** conversation = sidebar person/thread; message = full-text hit. */
  kind?: "conversation" | "message";
}

export interface SearchOutput {
  ok: boolean;
  online: boolean;
  error: string;
  results: SearchHit[];
}

/** Trim a long body to ~96 chars CENTERED on the first match so the reason
 *  this row exists is actually visible. Case-insensitive, like the query. */
export function snippet(text: string, query: string, width = 96): string {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= width) return t;
  const at = t.toLowerCase().indexOf(String(query || "").toLowerCase());
  if (at < 0) return t.slice(0, width - 1) + "…";
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), t.length - width));
  return (start > 0 ? "…" : "") + t.slice(start, start + width - 1).trim() + "…";
}

/** True when `query` (already lowercased) is a whole word at `at` in `text`.
 *  Letters and digits count as word characters, including Swedish åäö. */
function isWholeWordAt(text: string, at: number, queryLen: number): boolean {
  const left = at === 0 ? "" : text[at - 1]!;
  const right = at + queryLen >= text.length ? "" : text[at + queryLen]!;
  const wordChar = (c: string) => c !== "" && /[\p{L}\p{N}]/u.test(c);
  return !wordChar(left) && !wordChar(right);
}

/** 2 = case-insensitive whole word, 1 = substring, 0 = no match. */
export function messageMatchScore(query: string, text: string): number {
  const q = String(query || "").trim().toLowerCase();
  const t = String(text || "").toLowerCase();
  if (q === "" || t === "") return 0;
  let best = 0;
  let from = 0;
  while (from <= t.length - q.length) {
    const at = t.indexOf(q, from);
    if (at < 0) break;
    const score = isWholeWordAt(t, at, q.length) ? 2 : 1;
    if (score > best) best = score;
    if (best === 2) return 2;
    from = at + 1;
  }
  return best;
}

/** Whole-word hits first (case-insensitive), then substring hits. Within a
 *  tier, newer MESSAGE time first — not the thread's last_ts. Attachment-only
 *  rows are dropped. Self-thread echo twins collapse to one hit. */
export function shapeResults(raw: ImsgMessage[], query: string, limit: number): SearchHit[] {
  const out: (SearchHit & { score: number })[] = [];
  // Use the thread loader's sender-aware echo rules before discarding empty
  // bodies: an empty outgoing self row can identify its decoded incoming twin.
  // Outgoing rows lead. `imsg search` answers newest first, and a self-thread
  // message that Messages in iCloud re-synced has SEVERAL incoming copies;
  // dedupeSelfEcho folds a copy only into a row of the opposite direction, so
  // two copies ahead of the sent row left one behind as an incoming hit.
  const rows = [...raw].sort((a, b) => Number(b.from_me === true) - Number(a.from_me === true));
  for (const m of dedupeSelfEcho(rows)) {
    const body = (m.text ?? "").replace(/\uFFFC/g, "").trim();
    if (body === "") continue;
    out.push({
      chat: chatKey(m),
      name: m.name ?? m.handle ?? chatKey(m),
      handle: String(m.handle || ""),
      service: String(m.service || ""),
      ts: m.ts,
      from_me: m.from_me === true,
      text: snippet(body, query),
      group: isGroupChat(chatKey(m)),
      kind: "message",
      score: messageMatchScore(query, body),
    });
  }
  out.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.ts === b.ts) return 0;
    return a.ts < b.ts ? 1 : -1;
  });
  return out.slice(0, limit).map(({ score: _score, ...hit }) => hit);
}

/** Name, handle, and chat id only. Message bodies are a different search. */
export function conversationHaystack(t: {
  chat?: string; name?: string; handle?: string;
}): string {
  return [t.name, t.handle, t.chat].filter(Boolean).join(" ");
}

export function matchConversations(
  threads: {
    chat?: string; name?: string; handle?: string; service?: string;
    last_ts?: string; last_text?: string; last_from_me?: boolean;
  }[],
  query: string,
  limit = 8,
): SearchHit[] {
  const q = String(query || "").trim();
  if (q === "") return [];
  const scored: { score: number; t: (typeof threads)[number] }[] = [];
  for (const t of threads) {
    const score = fuzzyScore(q, conversationHaystack(t));
    if (score <= 0) continue;
    scored.push({ score, t });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ t }) => {
    const chat = String(t.chat || "");
    return {
      chat,
      name: String(t.name || t.handle || chat),
      handle: String(t.handle || ""),
      service: String(t.service || ""),
      ts: String(t.last_ts || ""),
      from_me: t.last_from_me === true,
      text: String(t.last_text || ""),
      group: isGroupChat(chat),
      kind: "conversation" as const,
    };
  });
}

export function mergeSearchResults(conversations: SearchHit[], messages: SearchHit[]): SearchHit[] {
  return conversations.map((h) => ({ ...h, kind: "conversation" as const }))
    .concat(messages.map((h) => ({ ...h, kind: h.kind ?? "message" })));
}

export function runSearch(
  query: string,
  limit: number,
  runner = spawnSync,
  threads: Parameters<typeof matchConversations>[0] = [],
): SearchOutput {
  const fail = (error: string, online = true): SearchOutput =>
    ({ ok: false, online, error, results: [] });
  const q = String(query || "").trim();
  if (q === "") return fail("empty query");

  // "--" so a query starting with "-" is a query, not a flag.
  // The query is message text the moment someone pastes a sentence into the
  // box: stdin to the bridge, never argv on either machine (Astra B#2).
  const res = runner(shimPath("imsg"), ["--json", "search", "--stdin", String(limit * 2)], {
    encoding: "utf8",
    timeout: 20000,
    input: q,
  });
  if (res.status === 69 || res.status === 255) return fail("Mac unreachable", false);
  if (res.status !== 0) {
    const err = (res.stderr || "").toString().trim().split("\n")[0] || `imsg exit ${res.status}`;
    return fail(err);
  }
  try {
    const parsed = JSON.parse(res.stdout as string);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    const messages = shapeResults(parsed, q, limit);
    return {
      ok: true, online: true, error: "",
      results: mergeSearchResults(matchConversations(threads, q), messages),
    };
  } catch (e) {
    return fail(`bad JSON from imsg: ${e}`);
  }
}

/** ONE stdin payload: either the legacy array of sidebar identities, or
 *  `{ query, threads }` — the query is message text the moment a sentence is
 *  pasted into the box, so with `--stdin` it travels here, never argv
 *  (Astra B#2). Read exactly once. */
export function parseStdinPayload(raw: string, wantQuery: boolean): { query: string; threads: Parameters<typeof matchConversations>[0] } {
  try {
    const parsed = JSON.parse(raw.trim() || "null") as unknown;
    if (Array.isArray(parsed)) return { query: "", threads: parsed as Parameters<typeof matchConversations>[0] };
    if (parsed && typeof parsed === "object") {
      const o = parsed as { query?: unknown; threads?: unknown };
      return {
        query: wantQuery ? String(o.query ?? "").trim() : "",
        threads: Array.isArray(o.threads) ? o.threads as Parameters<typeof matchConversations>[0] : [],
      };
    }
  } catch { /* not ours */ }
  return { query: "", threads: [] };
}

if (import.meta.main) {
  const arg = process.argv[2] ?? "";
  const limit = Number(process.argv[3] ?? 40) || 40;
  const payload = process.stdin.isTTY ? { query: "", threads: [] } : parseStdinPayload(readFileSync(0, "utf8"), arg === "--stdin");
  const query = arg === "--stdin" ? payload.query : arg;
  try {
    console.log(JSON.stringify(runSearch(query, limit, spawnSync, payload.threads)));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, online: true, error: String(e), results: [] }));
  }
}
