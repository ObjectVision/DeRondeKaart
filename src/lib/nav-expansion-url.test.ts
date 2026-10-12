import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  NAV_PARAM,
  branchToken,
  encodeNavExpansionParam,
  parseNavExpansionParam,
} from "@/lib/nav-expansion-url";

/**
 * An independent FNV-1a 32-bit, in BigInt.
 *
 * Deliberately not the same arithmetic as the implementation: that one uses
 * `Math.imul` for the 32-bit multiply, and the first draft of it expanded the
 * prime into shifts and got the result wrong for every non-empty input while
 * still matching on "". Checking against a BigInt reference — where overflow
 * cannot happen — is what catches that class of mistake.
 */
function referenceFnv1a(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let hash = 0x811c9dc5n;
  const mask = 0xffffffffn;
  for (const byte of bytes) {
    hash = (hash ^ BigInt(byte)) & mask;
    hash = (hash * 16777619n) & mask;
  }
  const out = Buffer.alloc(4);
  out.writeUInt32BE(Number(hash));
  return out.toString("base64url");
}

/** Every branch path in every shipped navigation.json, as the app keys them. */
function realBranchPaths(): Set<string> {
  const files: string[] = [];
  const walkDir = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkDir(full);
      else if (entry.name === "navigation.json") files.push(full);
    }
  };
  walkDir("configs");
  if (fs.existsSync("public/navigation.json")) files.push("public/navigation.json");

  const keys = new Set<string>();
  const collect = (items: { label: string; children?: unknown[] }[], parts: string[]) => {
    for (const item of items) {
      // Leaves have no `children` and no expansion state.
      if (!item.children) continue;
      const next = [...parts, item.label];
      keys.add(next.join(" / "));
      collect(item.children as { label: string; children?: unknown[] }[], next);
    }
  };
  for (const file of files) collect(JSON.parse(fs.readFileSync(file, "utf-8")), []);
  return keys;
}

describe("branchToken", () => {
  it("matches an independent FNV-1a implementation", () => {
    const samples = [
      "",
      "a",
      "ab",
      "Basisgegevens",
      "Basisgegevens / Woningen / Bouwjaar",
      // Labels are free text: Dutch punctuation and emoji must not throw the way
      // Latin-1-only `btoa` would on the raw string.
      "Kosten – 50 °C € 😀",
      "x".repeat(500),
    ];
    for (const sample of samples) {
      expect(branchToken(sample), `for ${JSON.stringify(sample)}`).toBe(referenceFnv1a(sample));
    }
  });

  it("is always 6 base64url characters", () => {
    for (const key of realBranchPaths()) {
      expect(branchToken(key)).toMatch(/^[A-Za-z0-9_-]{6}$/);
    }
  });

  it("does not collide across every branch path in every shipped config", () => {
    const keys = realBranchPaths();
    // Guards the guard: if the configs ever stop being found, the loop below
    // would pass vacuously.
    expect(keys.size).toBeGreaterThan(100);

    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const key of keys) {
      const token = branchToken(key);
      const previous = seen.get(token);
      if (previous !== undefined && previous !== key) {
        collisions.push(`${token}: ${JSON.stringify(previous)} <> ${JSON.stringify(key)}`);
      }
      seen.set(token, key);
    }
    expect(collisions, collisions.join("\n")).toEqual([]);
  });
});

describe("encode / parse round-trip", () => {
  it("round-trips an open/closed diff", () => {
    const diff = {
      "Basisgegevens": true,
      "Basisgegevens / Woningen": true,
      "Gevoeligheidsanalyses": false,
    };
    const raw = encodeNavExpansionParam(diff);
    const parsed = parseNavExpansionParam(raw);

    expect(parsed).not.toBeNull();
    expect(parsed!.open).toEqual(
      new Set([branchToken("Basisgegevens"), branchToken("Basisgegevens / Woningen")]),
    );
    expect(parsed!.closed).toEqual(new Set([branchToken("Gevoeligheidsanalyses")]));
  });

  it("returns an empty string for an empty diff, so the caller omits the param", () => {
    // A link from an untouched tree must not carry `nav=*`.
    expect(encodeNavExpansionParam({})).toBe("");
  });

  it("handles a group being empty on either side", () => {
    const onlyClosed = encodeNavExpansionParam({ Thema: false });
    expect(onlyClosed.startsWith("*")).toBe(true);
    expect(parseNavExpansionParam(onlyClosed)!.open.size).toBe(0);
    expect(parseNavExpansionParam(onlyClosed)!.closed.size).toBe(1);

    const onlyOpen = encodeNavExpansionParam({ Thema: true });
    expect(onlyOpen.endsWith("*")).toBe(true);
    expect(parseNavExpansionParam(onlyOpen)!.open.size).toBe(1);
    expect(parseNavExpansionParam(onlyOpen)!.closed.size).toBe(0);
  });

  it("survives a URLSearchParams round-trip unescaped", () => {
    const raw = encodeNavExpansionParam({ a: true, b: true, c: false });
    const params = new URLSearchParams();
    params.set(NAV_PARAM, raw);
    // `*` and `.` are left alone by URLSearchParams, so the serialized form
    // must be byte-identical. `~` would come back as %7E.
    expect(params.toString()).toBe(`${NAV_PARAM}=${raw}`);
    expect(new URLSearchParams(params.toString()).get(NAV_PARAM)).toBe(raw);
  });
});

describe("parseNavExpansionParam rejects malformed input", () => {
  it.each([
    ["no group separator", "QAk2aB"],
    ["too many groups", "QAk2aB*ekYLgH*mpjyEf"],
    ["token too short", "QAk2a*"],
    ["token too long", "QAk2aBX*"],
    ["token outside the base64url alphabet", "QAk2a+*"],
    ["empty token from a doubled separator", "QAk2aB..ekYLgH*"],
    ["the same token opened and closed", "QAk2aB*QAk2aB"],
  ])("%s", (_label, raw) => {
    expect(parseNavExpansionParam(raw)).toBeNull();
  });

  it("accepts a wholly empty diff string", () => {
    // `nav=*` is structurally valid even though the writer never emits it.
    const parsed = parseNavExpansionParam("*");
    expect(parsed).not.toBeNull();
    expect(parsed!.open.size).toBe(0);
    expect(parsed!.closed.size).toBe(0);
  });
});
