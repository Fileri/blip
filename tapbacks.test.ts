import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// imsg-react performs Messages' own tapback actions, named in the Mac's
// language. It is opt-in: the shim refuses it before anything reaches the Mac
// unless bridge.conf says tapbacks=on. A fake ssh records what would be sent.
describe("blip-shim: tapbacks=on gates imsg-react", () => {
  const shim = new URL("./bridge/linux/blip-shim", import.meta.url).pathname;

  function run(tool: string, conf: string) {
    const dir = mkdtempSync(join(tmpdir(), "blip-tapbacks-"));
    copyFileSync(shim, join(dir, tool));
    chmodSync(join(dir, tool), 0o755);
    writeFileSync(join(dir, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/ssh.log"\n`);
    chmodSync(join(dir, "ssh"), 0o755);
    writeFileSync(join(dir, "bridge.conf"), `host=mac.example\nkey=${dir}/no-key\n${conf}`);
    const r = spawnSync(join(dir, tool), ["--guid", "ABC", "love"], {
      encoding: "utf8",
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, BLIP_BRIDGE_CONF: join(dir, "bridge.conf") },
    });
    const log = existsSync(join(dir, "ssh.log")) ? readFileSync(join(dir, "ssh.log"), "utf8") : "";
    rmSync(dir, { recursive: true, force: true });
    return { code: r.status, err: r.stderr, log };
  }

  test("off by default: refused with EX_CONFIG, the Mac is never contacted", () => {
    for (const conf of ["", "tapbacks=off\n", "tapbacks=\n", "tapbacks=maybe\n"]) {
      const r = run("imsg-react", conf);
      expect(r.code).toBe(78);
      expect(r.err).toContain("tapbacks=on");
      expect(r.log).toBe("");
    }
  });

  test("tapbacks=on passes it through like any bridge tool", () => {
    for (const conf of ["tapbacks=on\n", "tapbacks=ON\n", 'tapbacks="yes"\n', "tapbacks=1\n"]) {
      const r = run("imsg-react", conf);
      expect(r.code).toBe(0);
      expect(r.log).toContain("imsg-react '--guid' 'ABC' 'love'");
    }
  });

  test("the menu reads the key exactly as the shim does", () => {
    const { tapbacksOn } = require("./tapback-actions") as typeof import("./tapback-actions");
    for (const conf of [
      "tapbacks=on\n", "tapbacks = on # yes\n", "tapbacks='True'\n", "tapbacks=on\ntapbacks=off\n",
      "tapbacks=off\ntapbacks=1\n", "# tapbacks=on\n", "tapbacks=onward\n", "tapbacks=\n", "tap backs=on\n",
    ]) {
      expect({ conf, on: run("imsg-react", conf).code === 0 }).toEqual({ conf, on: tapbacksOn(conf) });
    }
  });

  test("the key gates nothing else", () => {
    const r = run("imsg", "");
    expect(r.code).toBe(0);
    expect(r.log).toContain("imsg '--guid' 'ABC' 'love'");
  });

  test("the confined key's dispatch knows the tool", () => {
    const dispatch = readFileSync(new URL("./bridge/mac/blip-dispatch", import.meta.url), "utf8");
    expect(dispatch).toMatch(/TOOLS = \{[^}]*"imsg-react"/);
    const install = readFileSync(new URL("./bridge/mac/install.sh", import.meta.url), "utf8");
    expect(install).toMatch(/for t in [^;]*\bimsg-react\b/);
  });
});

// The JXA half runs only on a Mac, but the label matcher is plain JS and
// decides which bubble gets touched: a loose match lands on a neighbour.
describe("imsg-react: bubble label matching", () => {
  const src = readFileSync(new URL("./bridge/mac/imsg-react", import.meta.url), "utf8");
  const fn = (name: string) => {
    const start = src.indexOf(`function ${name}(`);
    return src.slice(start, src.indexOf("\n}\n", start) + 2);
  };
  const norm = src.slice(src.indexOf("function norm("), src.indexOf("\n", src.indexOf("function norm(")));
  const { parseLabel, bodyIs } = new Function(`${norm}\n${fn("parseLabel")}\n${fn("bodyIs")}\nreturn { parseLabel, bodyIs };`)();
  const matches = (label: string, text: string) => {
    const L = parseLabel(label);
    return !!L && bodyIs(L.body, text);
  };

  test("the text alone, or followed by its tapback annotation", () => {
    expect(matches("Ann, ok, 18:03", "ok")).toBe(true);
    expect(matches("Ann, ok, 2 reactions, You laughed at this, 18:03", "ok")).toBe(true);
    expect(matches("Ann, ok, 1 reaction, Bo loved this, 6:03 PM", "ok")).toBe(true);
    expect(matches("Ann, a, b, 18:03", "a, b")).toBe(true);
  });

  test("never a longer text that starts the same way", () => {
    expect(matches("Ann, ok, see you, 18:03", "ok")).toBe(false);
    expect(matches("Ann, ok, I loved this, 18:03", "ok")).toBe(false);
    expect(matches("Ann, ok, 2 reactions, and more, 18:03", "ok")).toBe(false);
    expect(matches("Ann, okay, 18:03", "ok")).toBe(false);
  });

  test("12-hour clocks read as 24-hour", () => {
    expect(parseLabel("Ann, ok, 6:03 PM").time).toBe("18:03");
    expect(parseLabel("Ann, ok, 12:05 AM").time).toBe("00:05");
  });
});

// The menu half. QML has no unit tests; these pin the wiring the logic in
// tapback-actions.ts depends on.
describe("message menu: tapbacks", () => {
  const view = readFileSync(new URL("./BlipView.qml", import.meta.url), "utf8");
  const widget = readFileSync(new URL("./BarWidget.qml", import.meta.url), "utf8");
  const menu = readFileSync(new URL("./MessageMenu.qml", import.meta.url), "utf8");

  test("off by default, from the same parser as the tests above", () => {
    expect(widget).toContain("property bool tapbacks: false");
    expect(widget).toContain("root.tapbacks = TapbackActions.tapbacksOn(t)");
    expect(widget).toContain("root.tapbacks = false;");
    expect(view).toContain("readonly property bool tapbacksOn: hostWidget ? hostWidget.tapbacks === true : false");
  });

  test("offered only for a bubble the tool acts on, and one at a time until chat.db has answered", () => {
    expect(view).toContain("tapbacksShown: root.tapbacksOn && TapbackActions.canTapback(root.messageContext, root.activeIsGroup)");
    expect(view).toContain("readonly property bool tapbacksBusy: reactProc.running || pendingTapback !== null");
    expect(view).toContain("tapbacksBusy: root.tapbacksBusy");
    expect(view).toContain("if (root.tapbacksBusy || !root.tapbacksOn || !TapbackActions.canTapback(message, root.activeIsGroup)) return");
    expect(menu).toContain("visible: menu.tapbacksShown");
    expect(menu).toContain("enabled: !menu.tapbacksBusy");
  });

  test("spawned through the conversation's source, add or remove decided by tapback-actions.ts", () => {
    expect(view).toContain('SourceId.bridgeArgv(reactProc.chat, "imsg-react", hostWidget ? hostWidget.binDir : root.home + "/bin")');
    // the pending pill and the tool are told the same thing
    expect(view).toContain("TapbackActions.pendingTapback(reactProc.chat, String(message.guid), kind, current)");
    expect(view).toContain("TapbackActions.tapbackArgs(String(message.guid), kind, current)");
  });

  test("keyboard: Ctrl+E on the selected bubble opens the menu, 1–6 in it pick a tapback", () => {
    expect(view).toContain("if (event.key === Qt.Key_E && (event.modifiers & Qt.ControlModifier)) { event.accepted = true; root.openMessageMenuAt(b, root.bubbleCursorItem); return }");
    // among the selected-bubble keys, so only with an empty draft and a bubble selected
    const keys = view.slice(view.indexOf("var b = empty && root.attachCount === 0 ? root.selectedBubble() : null"));
    expect(keys.indexOf("root.openMessageMenuAt(b")).toBeLessThan(keys.indexOf("root.send()"));
    expect(view).toContain("messageMenu.keyHints = true");
    expect(view).toContain("if (keyHints) composeField.forceActiveFocus()");
    expect(menu).toContain("    if (menu.tapbacksShown) tapbackStrip.forceActiveFocus()");
    expect(menu).toContain("var kind = marked ? TapbackActions.TAPBACKS[tapbackStrip.cursor].kind : TapbackActions.tapbackForKey(event.text)");
    // the number keys go through the same signal and busy gate as a click
    const strip = menu.slice(menu.indexOf("Keys.onPressed"), menu.indexOf("Row {"));
    expect(strip).toContain("menu.pickTapback(kind)");
    expect(menu).toContain("onTapped: menu.pickTapback(tapbackCell.modelData.kind)");
    const pick = menu.slice(menu.indexOf("function pickTapback"), menu.indexOf("onOpened:"));
    expect(pick.indexOf("if (menu.tapbacksBusy) return")).toBeLessThan(pick.indexOf("menu.tapbackRequested(kind)"));
    // Left/Right mark one along the row, Enter/Space pick it; unmarked, Enter stays the menu's
    expect(strip).toContain("tapbackStrip.cursor = TapbackActions.moveTapbackCursor(tapbackStrip.cursor, event.key === Qt.Key_Right ? 1 : -1)");
    expect(strip).toContain("var marked = tapbackStrip.cursor >= 0 && (event.key === Qt.Key_Return || event.key === Qt.Key_Enter || event.key === Qt.Key_Space)");
    expect(menu).toContain("tapbackStrip.cursor = TapbackActions.initialTapbackCursor(menu.myTapback, menu.keyHints)");
    expect(menu).toContain("readonly property bool marked: tapbackStrip.activeFocus && tapbackStrip.cursor === index");
  });

  test("the selected bubble stays selected when its tapback lands (a reload)", () => {
    expect(view).toContain("var keep = bubbleCursorGuid");
    expect(view).toContain("if (keep !== \"\") Qt.callLater(root.restoreBubbleCursor, keep)");
    expect(view).toContain("var i = MessageActions.bubbleIndexByGuid(bubbles, guid)");
    expect(view).not.toContain("onBubblesChanged: clearBubbleCursor()");
  });

  test("drawn at once as pending; chat.db settles it, a failure takes it away", () => {
    const exited = view.slice(view.indexOf("id: reactProc"), view.indexOf("// Attachment fetcher"));
    expect(exited).toContain("Object.assign({}, root.pendingTapback, { done: true })");
    expect(exited).toContain("if (!root.inThread || String(root.active.chat) !== reactProc.chat) root.pendingTapback = null");
    // the tool saw the row: the load starts at once, and after done, so it may settle the pill
    expect(exited).toContain("root.requestThreadLoad(reactProc.chat)");
    expect(exited.indexOf("{ done: true })")).toBeLessThan(exited.indexOf("root.requestThreadLoad(reactProc.chat)"));
    const failed = exited.slice(exited.indexOf("} else {"));
    expect(failed).toContain("root.pendingTapback = null");
    expect(failed).toContain("root.note = TapbackActions.tapbackFailure(code, reactProc.lastErr)");
    expect(exited).not.toContain("reactProc.running = true");
    // the dimmed pill is the only "on its way"; the status line speaks only for a failure
    expect(view).not.toContain('"tapback…"');
    expect(view).toContain('if (root.note.indexOf("tapback not sent") === 0) root.note = ""');
    // every load settles against what it read, knowing whether it started after the tool's exit
    expect(view).toContain("root.threadTapbackDone = !!(root.pendingTapback && root.pendingTapback.done)");
    expect(view).toContain("root.pendingTapback = TapbackActions.pendingAfterLoad(root.pendingTapback, root.threadRunningChat, list, root.threadTapbackDone)");
    expect(view).toContain("if (root.threadTapbackDone && root.pendingTapback && root.pendingTapback.chat === root.threadRunningChat) {");
    // the text bubble's pill and the room left for it both draw through shownTapbacks
    expect(view).toContain("readonly property var shownTapbacks: TapbackActions.shownTapbacks(modelData, root.pendingTapback)");
    expect(view).toContain("TapbackPill { mine: bubbleRow.mine; tapbacks: bubbleRow.shownTapbacks }");
    expect(view).toContain("+ (bubbleRow.shownTapbacks.length > 0 ? Style.space(12) : 0)");
    expect(view).toContain("opacity: (tapbacks || []).some(function(t) { return t.pending === true }) ? 0.45 : 1");
  });
});
