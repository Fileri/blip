// Pure message helpers (quotation, the selected bubble), shared with the QML renderer.
// Rebuild: bun build message-actions.ts --target browser --format esm --outfile MessageActions.mjs
export interface QuotableMessage {
  text?: string;
  link?: { url?: string } | null;
  retracted?: boolean;
}

export function quoteText(message: QuotableMessage): string {
  if (message.retracted) return "";
  return String(message.text || message.link?.url || "").replace(/\s+/g, " ").trim();
}

/** Keep the existing short quotation convention, with a visible truncation mark.
 * The user's draft is retained byte-for-byte after the quotation. */
export function quotedDraft(message: QuotableMessage, draft: string): string {
  const text = quoteText(message);
  if (!text) return draft;
  const points = Array.from(text);
  const excerpt = points.length > 200 ? points.slice(0, 200).join("") + "…" : text;
  return "> " + excerpt + "\n\n" + draft;
}

/** Where the selected bubble is after a reload: the row with the same guid,
 *  or -1 when it is gone or has none. A reload renumbers the rows, and a
 *  tapback landing on the selected bubble is itself a reload. */
export function bubbleIndexByGuid(bubbles: { guid?: string }[], guid: string): number {
  if (!guid) return -1;
  return (bubbles || []).findIndex((b) => String(b?.guid || "") === guid);
}
