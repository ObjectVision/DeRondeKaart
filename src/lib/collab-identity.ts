/**
 * Local collaboration identity: a display name + color shown to other
 * participants (cursor label, annotation author). Generated once and persisted
 * in localStorage so the same browser keeps its identity across sessions.
 * Names are self-chosen pseudonyms — nothing is verified.
 */

export interface CollabIdentity {
  name: string;
  color: string;
}

const STORAGE_KEY = "annot.identity";

/** Distinguishable palette; the index is picked at random per browser. */
export const IDENTITY_COLORS = [
  "#E5484D", // red
  "#E5772B", // orange
  "#8F8F28", // olive
  "#2F9E44", // green
  "#0E8A8A", // teal
  "#3E74A7", // brand blue
  "#6E56CF", // violet
  "#C7418E", // magenta
] as const;

const NAMES = [
  "Reiger",
  "Kievit",
  "Grutto",
  "Buizerd",
  "Zwaluw",
  "Roerdomp",
  "Wulp",
  "IJsvogel",
  "Ooievaar",
  "Leeuwerik",
  "Korenwolf",
  "Das",
  "Vos",
  "Ree",
  "Bever",
  "Otter",
  "Egel",
  "Eekhoorn",
  "Hermelijn",
  "Boommarter",
  "Hazelmuis",
  "Muurhagedis",
  "Vroedmeesterpad",
  "Vuursalamander",
  "Everzwijn",
];

function generateIdentity(): CollabIdentity {
  const name = `${NAMES[Math.floor(Math.random() * NAMES.length)]} ${
    Math.floor(Math.random() * 90) + 10
  }`;
  const color = IDENTITY_COLORS[Math.floor(Math.random() * IDENTITY_COLORS.length)];
  return { name, color };
}

/** The persisted identity for this browser, generated on first use. */
export function getCollabIdentity(): CollabIdentity {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CollabIdentity>;
      if (typeof parsed.name === "string" && typeof parsed.color === "string") {
        return { name: parsed.name, color: parsed.color };
      }
    }
  } catch {
    // Storage unavailable (private mode) — fall through to a fresh identity.
  }
  const identity = generateIdentity();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  } catch {
    // Non-persistent identity is fine.
  }
  return identity;
}

/** Parse "#rrggbb" into a deck.gl color tuple with the given alpha. */
export function hexToRgba(
  hex: string,
  alpha: number,
): [number, number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [62, 116, 167, alpha];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, alpha];
}
