// message-actions.ts
function quoteText(message) {
  if (message.retracted)
    return "";
  return String(message.text || message.link?.url || "").replace(/\s+/g, " ").trim();
}
function quotedDraft(message, draft) {
  const text = quoteText(message);
  if (!text)
    return draft;
  const points = Array.from(text);
  const excerpt = points.length > 200 ? points.slice(0, 200).join("") + "…" : text;
  return "> " + excerpt + `

` + draft;
}
function bubbleIndexByGuid(bubbles, guid) {
  if (!guid)
    return -1;
  return (bubbles || []).findIndex((b) => String(b?.guid || "") === guid);
}
export {
  bubbleIndexByGuid,
  quoteText,
  quotedDraft
};
