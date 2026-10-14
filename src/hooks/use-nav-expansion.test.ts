import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoot } from "solid-js";

import { useNavExpansion, pathKey } from "@/hooks/use-nav-expansion";
import { branchToken } from "@/lib/nav-expansion-url";
import type { NavNode } from "@/layers/navigation";

/**
 * A tree with one branch configured open and the rest closed, so every test can
 * distinguish "the user opened this" from "the config opens this".
 */
function tree(): NavNode[] {
  return [
    {
      label: "Basisgegevens",
      children: [
        { label: "Woningen", children: [{ id: "1", label: "Bouwjaar" }] },
        { label: "Energie", expanded: true, children: [{ id: "2", label: "Labels" }] },
      ],
    },
    { label: "Gevoeligheidsanalyses", children: [{ id: "3", label: "Variant A" }] },
  ];
}

/** Run a body inside a root so signals have an owner, and dispose after. */
function withHook<T>(body: (hook: ReturnType<typeof useNavExpansion>) => T): T {
  let result!: T;
  const dispose = createRoot((d) => {
    result = body(useNavExpansion(() => tree()));
    return d;
  });
  dispose();
  return result;
}

beforeEach(() => sessionStorage.clear());
afterEach(() => sessionStorage.clear());

describe("isOpen precedence", () => {
  it("falls back to the configured expanded, then to closed", () => {
    withHook((hook) => {
      expect(hook.isOpen(["Basisgegevens", "Energie"])).toBe(true); // expanded: true
      expect(hook.isOpen(["Basisgegevens", "Woningen"])).toBe(false); // unset
      expect(hook.isOpen(["Nope"])).toBe(false); // not in the tree at all
    });
  });

  it("lets a user toggle override the configured value in both directions", () => {
    withHook((hook) => {
      hook.toggle(["Basisgegevens", "Energie"]); // configured open -> closed
      expect(hook.isOpen(["Basisgegevens", "Energie"])).toBe(false);

      hook.toggle(["Basisgegevens", "Woningen"]); // configured closed -> open
      expect(hook.isOpen(["Basisgegevens", "Woningen"])).toBe(true);
    });
  });
});

describe("diffFromDefault", () => {
  it("is empty for an untouched tree", () => {
    withHook((hook) => expect(hook.diffFromDefault()).toEqual({}));
  });

  it("reports only what differs from the configured state", () => {
    withHook((hook) => {
      hook.toggle(["Basisgegevens", "Woningen"]); // false -> true
      hook.toggle(["Basisgegevens", "Energie"]); // true  -> false
      expect(hook.diffFromDefault()).toEqual({
        "Basisgegevens / Woningen": true,
        "Basisgegevens / Energie": false,
      });
    });
  });

  it("drops a branch toggled back to its configured state", () => {
    withHook((hook) => {
      // The override entry survives the round trip; the diff must not.
      hook.toggle(["Basisgegevens", "Woningen"]);
      hook.toggle(["Basisgegevens", "Woningen"]);
      expect(hook.diffFromDefault()).toEqual({});
    });
  });
});

describe("applyShared", () => {
  it("applies tokens that resolve against the current tree", () => {
    withHook((hook) => {
      hook.applyShared(
        new Set([branchToken(pathKey(["Basisgegevens", "Woningen"]))]),
        new Set([branchToken(pathKey(["Basisgegevens", "Energie"]))]),
      );
      expect(hook.isOpen(["Basisgegevens", "Woningen"])).toBe(true);
      expect(hook.isOpen(["Basisgegevens", "Energie"])).toBe(false);
    });
  });

  it("skips unknown tokens and still applies the rest", () => {
    withHook((hook) => {
      hook.applyShared(
        new Set([
          branchToken(pathKey(["Basisgegevens", "Woningen"])),
          // What a renamed or deleted label looks like from the recipient's side.
          branchToken("Een tak die hier niet bestaat"),
        ]),
        new Set(),
      );
      expect(hook.isOpen(["Basisgegevens", "Woningen"])).toBe(true);
      // The unknown token must not have become an override of its own.
      expect(Object.keys(hook.diffFromDefault())).toEqual(["Basisgegevens / Woningen"]);
    });
  });

  it("does nothing when no token resolves", () => {
    withHook((hook) => {
      hook.applyShared(new Set([branchToken("Onbekend")]), new Set());
      expect(hook.diffFromDefault()).toEqual({});
    });
  });

  it("round-trips a shared diff back to the same tree shape", () => {
    const diff = withHook((hook) => {
      hook.toggle(["Basisgegevens", "Woningen"]);
      hook.toggle(["Basisgegevens", "Energie"]);
      return hook.diffFromDefault();
    });

    // A fresh session, as the recipient would have.
    sessionStorage.clear();
    withHook((hook) => {
      const open = new Set<string>();
      const closed = new Set<string>();
      for (const [key, value] of Object.entries(diff)) {
        (value ? open : closed).add(branchToken(key));
      }
      hook.applyShared(open, closed);
      expect(hook.diffFromDefault()).toEqual(diff);
    });
  });
});

describe("sessionStorage", () => {
  it("persists a toggle and reads it back in a new instance", () => {
    withHook((hook) => hook.toggle(["Basisgegevens", "Woningen"]));
    withHook((hook) => expect(hook.isOpen(["Basisgegevens", "Woningen"])).toBe(true));
  });

  it("persists a shared state, so it survives like the user's own toggles", () => {
    withHook((hook) =>
      hook.applyShared(new Set([branchToken(pathKey(["Basisgegevens", "Woningen"]))]), new Set()),
    );
    withHook((hook) => expect(hook.isOpen(["Basisgegevens", "Woningen"])).toBe(true));
  });

  it.each([
    ["corrupt JSON", "{not json"],
    ["an array rather than an object", "[1,2,3]"],
    ["null", "null"],
  ])("starts fresh on %s", (_label, raw) => {
    sessionStorage.setItem("nav-expansion", raw);
    withHook((hook) => {
      expect(hook.isOpen(["Basisgegevens", "Energie"])).toBe(true); // configured value
      expect(hook.diffFromDefault()).toEqual({});
    });
  });

  it("keeps only boolean entries from a hand-edited blob", () => {
    sessionStorage.setItem(
      "nav-expansion",
      JSON.stringify({ "Basisgegevens / Woningen": true, "Basisgegevens / Energie": "nope" }),
    );
    withHook((hook) => {
      expect(hook.isOpen(["Basisgegevens", "Woningen"])).toBe(true);
      // The junk entry is dropped, so this falls back to its configured value.
      expect(hook.isOpen(["Basisgegevens", "Energie"])).toBe(true);
    });
  });
});
