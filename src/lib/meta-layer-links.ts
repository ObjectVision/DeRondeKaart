import { chromeIconColor } from "@/config/map-config";

/**
 * Hostname of the retired 2025 mapviewer. The published metainfo fragments still
 * link every layer cross-reference there, so those links are dead as authored;
 * we intercept them and add the layer to the current viewer instead.
 */
const LEGACY_VIEWER_HOST = "kaartviewer.startanalyse2025.nl";

/** Query parameter carrying the layer id, e.g. `?layerIds=226`. */
const LAYER_ID_PARAM = "layerIds";

/**
 * Stands in for a link whose layer this viewer does not publish. No layer can
 * carry it, so it fails the `knownIds` check and renders as unavailable.
 */
const UNRESOLVED_LAYER_ID = "";

/** Glyph shown on a "Gerelateerde kaartlagen" button, by state. */
const ICON_ON_MAP = "check_circle";
const ICON_ADD = "add_circle";
const ICON_UNAVAILABLE = "remove";

export interface MetaLayerLink {
  /** Layer id as it appears in layers.json. Kept a string — ids are not all numeric. */
  layerId: string;
  /** True for the "Gerelateerde kaartlagen" button form, false for inline prose. */
  isButton: boolean;
}

/**
 * Maps a "Gerelateerde kaartlagen" row to the layer it names, keyed
 * `"<scenario> <code>"` — e.g. `"S3 H01"` -> `"154"`.
 *
 * Needed because the published hrefs are wrong: within one document all six rows
 * carry the SAME `layerIds`, even though each row names a different scenario
 * (LN, S1..S4, R23, R30). Following the href would add the same layer six times,
 * so the row's own thumbnail and label are the authoritative source instead.
 */
export type MetaLayerIndex = ReadonlyMap<string, string>;

/** Layer names carry their scenario and code as a suffix, e.g. "CO₂-uitstoot (LN H15)". */
const LAYER_NAME_SUFFIX_RE = /\((LN|S1|S2|S3|S4|R23|R30|G-LN)\s+([HR]\d+)\)\s*$/;

/** Thumbnail file naming the row's scenario, e.g. ".../symbolen/S3.png". */
const ROW_THUMB_RE = /symbolen\/([A-Za-z0-9-]+)\.png/;

/** Row label opening with the indicator code, e.g. "H01: Energieverbruik". */
const ROW_CODE_RE = /\b([HR]\d+)\s*:/;

/** Builds the scenario+code -> layer id index from the loaded layer configs. */
export function buildMetaLayerIndex(
  configs: ReadonlyArray<{ id: string; name: string }>,
): MetaLayerIndex {
  const index = new Map<string, string>();
  for (const config of configs) {
    const match = LAYER_NAME_SUFFIX_RE.exec(config.name);
    if (!match) continue;
    index.set(`${match[1]} ${match[2]}`, config.id);
  }
  return index;
}

/**
 * The layer a "Gerelateerde kaartlagen" row actually names, from its thumbnail
 * (the scenario) and label (the indicator code) — or null when the row names a
 * layer this viewer does not publish.
 */
function resolveRowLayerId(anchor: HTMLAnchorElement, index: MetaLayerIndex): string | null {
  const row = anchor.closest("li");
  if (!row) return null;
  const thumb = row.querySelector("img")?.getAttribute("src");
  const scenario = thumb ? ROW_THUMB_RE.exec(thumb) : null;
  const code = ROW_CODE_RE.exec(row.textContent ?? "");
  if (!scenario || !code) return null;
  return index.get(`${scenario[1]} ${code[1]}`) ?? null;
}

/**
 * True when the anchor is one of the "Gerelateerde kaartlagen" buttons rather
 * than an inline prose cross-reference.
 *
 * Keyed on the publisher's own `<span class="material-icons">` wrapper, which is
 * present on every button and on no prose link. That wrapper is structural,
 * unlike the anchor's text, which is prose a publisher could reword.
 */
function isButtonAnchor(anchor: HTMLAnchorElement): boolean {
  return anchor.closest("span.material-icons") !== null;
}

/**
 * Some published fragments omit the space before the next attribute, so the HTML
 * parser folds it into the query value: `?layerIds=305target="_blank"`. The id is
 * still recoverable — cut at the attribute-looking tail rather than dropping the
 * link, which would silently lose five working cross-references.
 */
function stripTrailingAttribute(value: string): string {
  const at = value.search(/[a-z-]+=/i);
  if (at === -1) return value;
  return value.slice(0, at);
}

/**
 * Reads a legacy mapviewer link off an anchor, or null when the anchor is
 * anything else (an ordinary outbound link, or a viewer URL without a layer id).
 *
 * Uses the resolved `anchor.href`, not the raw attribute: some fragments write
 * the href unquoted (`href=https://…?layerIds=275 target="_blank"`), and reading
 * it through the DOM lets the HTML parser normalize both spellings into one.
 */
export function parseMetaLayerLink(
  anchor: HTMLAnchorElement,
  index?: MetaLayerIndex,
): MetaLayerLink | null {
  let url: URL;
  try {
    url = new URL(anchor.href);
  } catch {
    // A href the URL parser rejects is left alone: without an id there is
    // nothing to add, so the anchor keeps its default behaviour.
    return null;
  }
  if (url.hostname !== LEGACY_VIEWER_HOST) return null;

  const raw = url.searchParams.get(LAYER_ID_PARAM);
  if (!raw) return null;
  const layerId = stripTrailingAttribute(raw);
  if (!layerId) return null;

  const isButton = isButtonAnchor(anchor);
  // A button's href names the wrong layer in most published rows (see
  // MetaLayerIndex), so prefer what the row itself says. Prose links carry no
  // row to read and their hrefs are correct, so they keep the href id.
  if (isButton && index) {
    const fromRow = resolveRowLayerId(anchor, index);
    // The row names a layer this viewer does not publish. Reporting it as
    // unresolved rather than falling back to the href is deliberate: the href
    // points at a DIFFERENT, existing layer, so honouring it would silently add
    // the wrong one.
    if (!fromRow) return { layerId: UNRESOLVED_LAYER_ID, isButton };
    return { layerId: fromRow, isButton };
  }

  return { layerId, isButton };
}

/** Replace a button anchor's text with a Material Symbols glyph name. */
function renderButtonIcon(anchor: HTMLAnchorElement, glyph: string): void {
  const wrapper = anchor.closest("span.material-icons");
  if (wrapper instanceof HTMLElement) {
    wrapper.classList.add("material-symbols-outlined");
    // The fragments link Google's Material *Icons* stylesheet, whose
    // `.material-icons` rule has the same specificity as the class just added
    // and is injected later, so it would win and leave the new glyph names
    // unresolved. An inline font-family outranks both. The publisher's class
    // stays for the sizing and ligature settings it also carries.
    wrapper.style.fontFamily = "Material Symbols Outlined";
  }
  anchor.textContent = glyph;
}

/**
 * Restyles the legacy links inside already-injected metainfo HTML: the buttons
 * get a state glyph, unavailable layers are muted, and everything gets a Dutch
 * tooltip.
 *
 * Runs directly on the DOM because the surrounding markup is publisher HTML
 * injected via dangerouslySetInnerHTML — React does not own these nodes. Safe to
 * re-run: every write is an assignment, so the pass is idempotent and is how the
 * icons follow the map's state.
 */
export function decorateMetaLayerLinks(
  container: HTMLElement,
  knownIds: ReadonlySet<string>,
  isOnMap: (id: string) => boolean,
  index: MetaLayerIndex,
): void {
  for (const anchor of container.querySelectorAll("a")) {
    const link = parseMetaLayerLink(anchor, index);
    if (!link) continue;

    // Nothing here navigates any more, so drop the new-tab hint the publisher
    // set for the old viewer.
    anchor.removeAttribute("target");

    if (!knownIds.has(link.layerId)) {
      anchor.title = "Deze kaartlaag is niet beschikbaar in deze viewer";
      anchor.style.color = "rgb(156 163 175)";
      anchor.style.textDecoration = "none";
      anchor.style.cursor = "default";
      if (link.isButton) renderButtonIcon(anchor, ICON_UNAVAILABLE);
      continue;
    }

    const onMap = isOnMap(link.layerId);
    anchor.style.cursor = "pointer";

    if (!link.isButton) {
      // Prose links stay ordinary underlined text: a glyph mid-sentence would
      // break the paragraph's rhythm.
      anchor.title = "Toon deze kaartlaag op de linker kaart";
      continue;
    }

    anchor.title = onMap ? "Staat op de linker kaart" : "Toon op de linker kaart";
    anchor.style.color = chromeIconColor();
    anchor.style.textDecoration = "none";
    renderButtonIcon(anchor, onMap ? ICON_ON_MAP : ICON_ADD);
  }
}
