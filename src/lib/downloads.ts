/** Where the per-variant dataset archives are published. */
const DOWNLOADS_BASE = "https://data.startanalyse2026.nl/downloads";

export interface DownloadItem {
  /** An asset under public/icons/, resolved by the Icon component. */
  icon: string;
  label: string;
  /** Archive filename, identical under every variant directory. */
  file: string;
}

/**
 * The strategy flags, in the order the navigation tree presents them, each
 * paired with the archive holding that dataset.
 *
 * The pairing is not derivable from the names. Two cases to leave alone:
 *
 * - `R23.svg` is "Referentie 2023" but its data ships as `ref19` — the same
 *   spelling its navigation entry already points at (`ref19.pmtiles`).
 * - `GLN.svg` covers all eleven sensitivity runs, which are published as one
 *   merged `LNGA.zip` rather than `LNGA01`…`LNGA11`.
 */
export const DOWNLOADS: readonly DownloadItem[] = [
  { icon: "LN.svg", label: "Laagste nationale kosten", file: "stratLN.zip" },
  { icon: "GLN.svg", label: "Gevoeligheidsanalyses", file: "LNGA.zip" },
  { icon: "S1.svg", label: "Strategie 1: eWP", file: "strat1.zip" },
  { icon: "S2.svg", label: "Strategie 2: MT-warmtenet", file: "strat2.zip" },
  { icon: "S3.svg", label: "Strategie 3: Combi LT-WN & eWP", file: "strat3.zip" },
  { icon: "S4.svg", label: "Strategie 4: hWP met klimaatneutraal gas", file: "strat4.zip" },
  { icon: "R23.svg", label: "Referentie 2023", file: "ref19.zip" },
  { icon: "R30.svg", label: "Referentie 2030", file: "ref30.zip" },
];

/** URL of one archive under the given variant, e.g. `…/downloads/2026/LNGA.zip`. */
export function downloadUrl(variant: string, file: string): string {
  return `${DOWNLOADS_BASE}/${variant}/${file}`;
}
