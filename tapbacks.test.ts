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
