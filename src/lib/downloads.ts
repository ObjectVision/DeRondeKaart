/** Where the dataset archives are published. */
const DOWNLOADS_BASE = "https://data.startanalyse2026.nl/downloads";

export interface DownloadItem {
  /** An asset under public/icons/, resolved by the Icon component. */
  icon: string;
  label: string;
  /**
   * Archive filename. One archive serves every variant: each holds both model
   * years internally, under `2025/` and `2026/` directories.
   */
  file: string;
}

/**
 * The strategy flags, in the order the navigation tree presents them, each
 * paired with the archive holding that dataset.
 *
 * The pairing is not derivable from the names:
 *
 * - `GLN.svg` covers all eleven sensitivity runs, which are published as one
 *   merged `LNGA.zip` rather than `LNGA01`…`LNGA11`.
 * - `LN.svg` is served by `stratLN.zip`, not a file named after the flag.
 *
 * Note the 2023 reference is `ref23.zip` here while its map layer is still
 * served from `ref19.pmtiles` — the archive was renamed, the tile source was
 * not.
 */
export const DOWNLOADS: readonly DownloadItem[] = [
  { icon: "LN.svg", label: "Laagste nationale kosten", file: "stratLN.zip" },
  { icon: "GLN.svg", label: "Gevoeligheidsanalyses", file: "LNGA.zip" },
  { icon: "S1.svg", label: "Strategie 1: eWP", file: "strat1.zip" },
  { icon: "S2.svg", label: "Strategie 2: MT-warmtenet", file: "strat2.zip" },
  { icon: "S3.svg", label: "Strategie 3: Combi LT-WN & eWP", file: "strat3.zip" },
  { icon: "S4.svg", label: "Strategie 4: hWP met klimaatneutraal gas", file: "strat4.zip" },
  { icon: "R23.svg", label: "Referentie 2023", file: "ref23.zip" },
  { icon: "R30.svg", label: "Referentie 2030", file: "ref30.zip" },
];

/**
 * URL of one archive, e.g. `…/downloads/LNGA.zip`.
 *
 * No variant segment: the archives were republished flat, each holding both
 * model years, so one URL serves every variant. The former
 * `…/downloads/<year>/<file>` paths are gone and 404.
 */
export function downloadUrl(file: string): string {
  return `${DOWNLOADS_BASE}/${file}`;
}
