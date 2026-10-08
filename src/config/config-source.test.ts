import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  CONFIG_PARAM,
  requestedConfigBase,
  resolveConfigBase,
} from "./config-source";

/**
 * The allowlist is a security control, not a convenience. A config decides the
 * HTML this app assigns to `innerHTML` and every URL it fetches, so a base that
 * slips through runs script on this origin.
 *
 * That makes the REFUSALS the tests worth having: a permanently-open parameter
 * and a correct one look identical from the accept side, and every bug here
 * fails open and silently.
 */

const GITHUB = "https://raw.githubusercontent.com/ObjectVision/configs";
const ALLOW = [GITHUB];

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveConfigBase — accepting", () => {
  it("accepts the allowlisted prefix itself", () => {
    expect(resolveConfigBase(GITHUB, ALLOW)).toBe(GITHUB);
  });

  it("accepts a folder under it", () => {
    expect(resolveConfigBase(`${GITHUB}/main/objectvision`, ALLOW)).toBe(
      `${GITHUB}/main/objectvision`,
    );
  });

  // configPath appends "/map.json", so a trailing slash would produce "//map.json".
  it("strips trailing slashes so the path cannot double up", () => {
    expect(resolveConfigBase(`${GITHUB}/main/`, ALLOW)).toBe(`${GITHUB}/main`);
    expect(resolveConfigBase(`${GITHUB}///`, ALLOW)).toBe(GITHUB);
  });
});

describe("resolveConfigBase — refusing", () => {
  it("refuses when no parameter was given", () => {
    expect(resolveConfigBase(null, ALLOW)).toBeNull();
    expect(resolveConfigBase("", ALLOW)).toBeNull();
  });

  /**
   * The default state of every deployment that has not opted in. If this ever
   * returned the base, adding the feature would silently open every existing
   * instance to any config.
   */
  it("refuses everything when the allowlist is empty", () => {
    expect(resolveConfigBase(GITHUB, [])).toBeNull();
  });

  it("refuses a host that is not on the list", () => {
    expect(resolveConfigBase("https://evil.example/configs", ALLOW)).toBeNull();
  });

  /**
   * The prefix-boundary case: a bare startsWith would admit this, and
   * "ObjectVisionEvil" is a different GitHub account that anyone can register.
   */
  it("refuses a sibling path that merely starts with an allowed prefix", () => {
    expect(
      resolveConfigBase("https://raw.githubusercontent.com/ObjectVisionEvil/x", ALLOW),
    ).toBeNull();
  });

  // Plaintext transport would let anyone on the path rewrite the HTML this app injects.
  it("refuses http", () => {
    const http = "http://raw.githubusercontent.com/ObjectVision/configs";
    expect(resolveConfigBase(http, [http])).toBeNull();
  });

  it("refuses credentials in the URL", () => {
    expect(
      resolveConfigBase("https://user:pw@raw.githubusercontent.com/ObjectVision/configs", ALLOW),
    ).toBeNull();
  });

  // A base is a folder; configPath appends to it, so a query or fragment means
  // the caller is pointing at something this cannot build file URLs from.
  it.each(["?ref=main", "#readme"])("refuses a base carrying %s", (tail) => {
    expect(resolveConfigBase(`${GITHUB}${tail}`, ALLOW)).toBeNull();
  });

  it("refuses something that is not a URL at all", () => {
    expect(resolveConfigBase("../../etc/passwd", ALLOW)).toBeNull();
    expect(resolveConfigBase("javascript:alert(1)", ALLOW)).toBeNull();
  });

  // An unusable entry must not crash the check or widen it.
  it("ignores a malformed allowlist entry and still refuses", () => {
    expect(resolveConfigBase(GITHUB, ["not a url"])).toBeNull();
  });

  it("still accepts via a good entry beside a malformed one", () => {
    expect(resolveConfigBase(GITHUB, ["not a url", GITHUB])).toBe(GITHUB);
  });
});

describe("requestedConfigBase", () => {
  it("reads the parameter from a query string", () => {
    expect(requestedConfigBase(`?${CONFIG_PARAM}=${encodeURIComponent(GITHUB)}`)).toBe(GITHUB);
  });

  it("is null when absent", () => {
    expect(requestedConfigBase("?variant=2026")).toBeNull();
  });
});
