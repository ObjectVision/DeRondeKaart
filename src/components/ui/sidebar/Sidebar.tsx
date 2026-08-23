import { Show, createEffect, createMemo, createSignal, type JSX } from "solid-js";
import { Icon } from "@/components/ui/nav-icon";
import { Button } from "@/components/ui/button";
import { LayerDescription } from "@/components/ui/navigation/LayerDescription";
import { FilterSection } from "./FilterSection";
import { NavigationSection } from "./NavigationSection";
import { loadNavigation, withCombinations, type NavLeaf, type NavNode } from "@/layers/navigation";
import { loadLayerConfigs } from "@/layers";
import { useNavExpansion } from "@/hooks/use-nav-expansion";
import type { NavigationApi } from "@/hooks/use-navigation";
import type { AreaFilterState } from "@/hooks/use-area-filter";
import { chromeIconSize, chromeIconColor } from "@/config/map-config";
import { variantId } from "@/config/variant";

interface LeafStateToggleProps {
  leaf: NavLeaf;
  nav: NavigationApi;
}

/**
 * Permanent on-map state toggle shown at the right edge of every layer row.
 * `circle` when the layer is on neither map (click adds it to the left map);
 * `check_circle` when it is on the left and/or right map (click removes it from
 * every map it is on). The rest of the row handles add/meta — see handleRowClick.
 */
function LeafStateToggle(props: LeafStateToggleProps): JSX.Element {
  const onLeft = () => props.nav.isOnMap(props.leaf.id, "left");
  const onRight = () => props.nav.isOnMap(props.leaf.id, "right");
  const onMap = () => onLeft() || onRight();

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      class="flex-shrink-0"
      onClick={(e) => {
        // Keep the row's own click handler from also firing.
        e.stopPropagation();
        if (onMap()) {
          // Remove from every map the layer is on.
          if (onLeft()) props.nav.toggleOnMap(props.leaf.id, "left");
          if (onRight()) props.nav.toggleOnMap(props.leaf.id, "right");
        } else {
          props.nav.toggleOnMap(props.leaf.id, "left"); // always add to the left map
        }
      }}
      title={onMap() ? "Verwijder van kaart" : "Toon op linker kaart"}
      aria-label={
        onMap()
          ? `Verwijder ${props.leaf.label} van kaart`
          : `Toon ${props.leaf.label} op linker kaart`
      }
      aria-pressed={onMap()}
    >
      <Icon
        name={onMap() ? "check_circle" : "circle"}
        size={chromeIconSize()}
        color={chromeIconColor()}
      />
    </Button>
  );
}

interface SidebarProps {
  nav: NavigationApi;
  areaFilter: AreaFilterState;
  /** Append the "Combinaties" theme (map.json `combinations`). */
  showCombinations?: boolean;
  /** Filter layers the user has created, shown under "Combinaties". */
  combinationLeaves?: NavLeaf[];
  /** Render the Filter section (false = minimized or disabled in config). */
  showFilter?: boolean;
  /** Render the Navigatie section (false = minimized or disabled in config). */
  showNavigation?: boolean;
  /** Close the whole navigation window (Filter + Navigatie together). */
  onClose?: () => void;
  /**
   * Toolbar row (search/zoom + section toggles) rendered above the sections.
   * Stays visible when both sections are minimized — it is how they are
   * restored.
   */
  toolbar?: JSX.Element;
  /** Opens a layer's metainfo dialog from the info button under its description. */
  onOpenMeta?: (layerId: string, layerName: string) => void;
}

/**
 * Left sidebar (map.json `navigationMode: "sidebar"`): the Filter section on
 * top of the Navigatie treeview. The top level is the category rows; clicking
 * one expands its branches and leaves in place beneath it, leaving the sibling
 * categories visible so the user keeps their bearings. Each layer row carries a
 * permanent on-map state toggle (LeafStateToggle); clicking the rest of the row
 * adds the layer and/or toggles its meta info panel below the row (see
 * handleRowClick).
 */
export function Sidebar(props: SidebarProps): JSX.Element {
  const [tree, setTree] = createSignal<NavNode[]>([]);
  // The row whose meta info panel is currently open (null = none open).
  const [metaOpenLeafId, setMetaOpenLeafId] = createSignal<string | null>(null);
  // Layer ids that have a `description`, with the layer's name for the dialog
  // title. handleRowClick decides whether to open the info panel synchronously,
  // so these are preloaded here rather than resolved per click.
  //
  // Keyed on `description` alone, not on metainfo: a layer with only metainfo
  // has nothing to show in the panel, and expanding it just to say "Geen
  // omschrijving beschikbaar" is noise. Its metainfo is still one click away
  // from the legend's info tool.
  const [infoLayers, setInfoLayers] = createSignal<Map<string, string>>(new Map());

  // An effect rather than onMount: a config-variant switch replaces both files,
  // and onMount fires once. Reading `variantId()` first — before any await or
  // early return — is what subscribes this to the switch.
  createEffect(() => {
    variantId();
    loadNavigation()
      .then(setTree)
      .catch((err) => console.error("Failed to load navigation.json:", err));
    // loadLayerConfigs memoizes per variant, so this shares the parse with
    // useNavigation.
    loadLayerConfigs()
      .then((configs) =>
        setInfoLayers(
          new Map(configs.filter((c) => c.description).map((c) => [c.id, c.name])),
        ),
      )
      .catch((err) => console.error("Failed to load layers.json:", err));
  });

  // The "Combinaties" theme is appended to the loaded tree rather than stored in
  // it, so the user's session-scoped filter layers stay out of the cached JSON.
  const visibleTree = createMemo(() =>
    props.showCombinations ? withCombinations(tree(), props.combinationLeaves ?? []) : tree(),
  );

  // Branch expansion is remembered for the session and seeded from each node's
  // `expanded` in navigation.json. Lifted out of the rows because collapsing a
  // theme unmounts its subtree — see use-nav-expansion.ts.
  // the hook takes the accessor
  // itself and reads it inside its own tracked scope
  // eslint-disable-next-line solid/reactivity
  const { isOpen, toggle } = useNavExpansion(visibleTree);

  const showFilter = () => props.showFilter ?? true;
  const showNavigation = () => props.showNavigation ?? true;
  const filterVisible = () => showFilter() && props.areaFilter.entries().length > 0;
  const sectionsVisible = () => filterVisible() || showNavigation();

  // Row click (anywhere except the on-map state toggle). One combined gesture:
  //  - info panel open → close it (whether or not the layer is on a map).
  //  - layer not on any map (panel collapsed) → add it to the left map; open its
  //    info panel if it has a description or metainfo, otherwise just toggle.
  //  - layer on a map (panel collapsed) → remove the layer from every map.
  function handleRowClick(leaf: NavLeaf) {
    // An open meta panel always collapses first — even for an off-map layer.
    if (metaOpenLeafId() === leaf.id) {
      setMetaOpenLeafId(null);
      return;
    }

    const onLeft = props.nav.isOnMap(leaf.id, "left");
    const onRight = props.nav.isOnMap(leaf.id, "right");

    if (!onLeft && !onRight) {
      props.nav.toggleOnMap(leaf.id, "left");
      setMetaOpenLeafId(infoLayers().has(leaf.id) ? leaf.id : null);
      return;
    }

    // On a map with the meta collapsed → remove from every map it is on.
    if (onLeft) props.nav.toggleOnMap(leaf.id, "left");
    if (onRight) props.nav.toggleOnMap(leaf.id, "right");
    setMetaOpenLeafId(null);
  }

  return (
    // Nothing at all to show — don't render an empty wrapper (and let map
    // clicks through). The toolbar alone still renders: it is how minimized
    // sections are restored.
    <Show when={sectionsVisible() || props.toolbar}>
      {/* Toolbar row on top, then the sections card. Positioning is the left
          column's job (see App.tsx) — this component only stacks its own content.
          It takes the space the legend's 25vh cap leaves over, so it shrinks
          (min-h-0) rather than pushing the legend out of the column. */}
      <div class="flex min-h-0 flex-col items-start gap-2">
        <Show when={props.toolbar}>
          {/* Always fully visible: the tool buttons keep their space above the
              card, and only the card below them scrolls. */}
          <div class="pointer-events-auto flex flex-shrink-0 items-center gap-2">
            {props.toolbar}
          </div>
        </Show>

        <Show when={sectionsVisible()}>
          {/* At most 70% of the viewport, leaving room for the toolbar row above
              and — with the legend's 25% cap below (see App.tsx) — the gaps
              between them. Longer content (category trees, info panels) scrolls
              inside the card; `min-h-0` lets it shrink further inside the flex
              column rather than pushing the legend off-screen. */}
          <div class="app-scrollbar pointer-events-auto relative flex max-h-[70vh] min-h-0 w-panel flex-col gap-4 overflow-y-auto rounded-2xl bg-white/95 p-3 shadow-md backdrop-blur-sm">
            <Show when={props.onClose}>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={props.onClose}
                title="Navigatie verbergen"
                aria-label="Navigatie verbergen"
                class="absolute right-2 top-2 z-10 h-5 w-5"
              >
                <Icon name="remove" size={chromeIconSize()} color={chromeIconColor()} />
              </Button>
            </Show>
            <Show when={filterVisible()}>
              <FilterSection areaFilter={props.areaFilter} />
            </Show>
            <Show when={showNavigation()}>
              <NavigationSection
                tree={visibleTree()}
                isOpen={isOpen}
                onToggle={toggle}
                selectedLeafId={metaOpenLeafId() ?? undefined}
                onSelectLeaf={handleRowClick}
                leafDetail={(leaf) => (
                  <div class="ml-7 mt-0.5 max-h-48 overflow-y-auto rounded-lg bg-gray-50 p-2 text-sm leading-relaxed text-gray-600">
                    <LayerDescription
                      layerId={leaf.id}
                      layerName={infoLayers().get(leaf.id) ?? leaf.label}
                      onOpenMeta={props.onOpenMeta}
                    />
                  </div>
                )}
                leafStatus={(leaf) => <LeafStateToggle leaf={leaf} nav={props.nav} />}
              />
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
}
