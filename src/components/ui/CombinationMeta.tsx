import { For, Show, createResource, type JSX } from "solid-js";
import { loadLayerConfigs } from "@/layers";
import { getFilterLayerById } from "@/layers/filter-layers";
import { describeCombination } from "@/layers/combination-meta";
import { META_ROUTES } from "@/layers/meta-routes";
import { TabStrip } from "@/components/ui/tab-strip";
import { Swatch } from "@/components/ui/swatch";
import { ruleSwatchSpec } from "@/lib/legend-style";

interface CombinationMetaProps {
  /** A `filter__*` id. */
  layerId: string;
}

/** The single tab a combination has — Toelichting, under its usual label. */
const TABS = [META_ROUTES[0]];

/** Swatch edge in px — the legend's size for rule rows. */
const SWATCH_SIZE = 10;

/**
 * The metainfo of a combination layer: a Toelichting generated from its
 * definition, since a combination is never in layers.json and has no published
 * fragment to fetch (compare LeafMeta).
 *
 * Rendered as JSX rather than as an HTML string through LeafMeta's
 * `innerHTML`: the content is built from user-typed names, and JSX escapes them.
 *
 * Only Toelichting: a combination has no sources beyond its layers, whose own
 * metainfo covers them, and no assumptions beyond the scoring rule stated here.
 * The tab strip is still rendered, so the window reads like every other
 * metainfo window.
 */
export function CombinationMeta(props: CombinationMetaProps): JSX.Element {
  const [description] = createResource(
    () => props.layerId,
    async (layerId) => {
      const def = getFilterLayerById(layerId);
      if (!def) return null;
      return describeCombination(def, await loadLayerConfigs());
    },
  );

  return (
    <Show when={!description.loading} fallback={<span class="text-gray-400">Laden…</span>}>
      <Show when={description()} fallback={<>Geen informatie beschikbaar</>}>
        {(info) => (
          <>
            <TabStrip tabs={TABS} active={TABS[0].id} onSelect={() => {}} />
            <div class="prose prose-sm max-w-none">
              <h3>{info().name}</h3>
              <p>
                Deze kaartlaag is zelf samengesteld door klassen van andere kaartlagen te
                combineren. Per locatie wordt geteld aan hoeveel van de gekozen criteria
                wordt voldaan.
              </p>

              <h4>Combinatiestrategie</h4>
              <p>{info().strategy}.</p>
              <p>
                Elke kaartlaag is één criterium. Een locatie voldoet aan een criterium
                wanneer de waarde binnen één van de gekozen klassen van die laag valt;
                meerdere klassen van dezelfde laag gelden dus als alternatieven. De
                score is het aantal criteria waaraan wordt voldaan, van 1 tot en met{" "}
                {info().criteria.length}.
              </p>

              <h4>Criteria</h4>
              <ul class="not-prose flex flex-col gap-3 pl-0">
                <For each={info().criteria}>
                  {(criterion) => (
                    <li class="list-none">
                      <div class="text-sm font-semibold text-gray-900">
                        {criterion.name}
                        <Show when={criterion.year}>
                          {(year) => <span class="font-normal text-gray-500"> · {year()}</span>}
                        </Show>
                      </div>
                      <Show when={criterion.subname}>
                        <div class="text-xs text-gray-500">{criterion.subname}</div>
                      </Show>
                      <Show when={criterion.combination}>
                        <div class="text-xs text-gray-500">
                          Zelf een combinatie; de gekozen klassen zijn scores daarvan.
                          Wordt die combinatie aangepast, dan past deze laag mee.
                        </div>
                      </Show>
                      <Show when={criterion.missing}>
                        <div class="text-xs text-gray-500">
                          Deze kaartlaag is in de huidige kaartversie niet beschikbaar.
                        </div>
                      </Show>
                      <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                        <For each={criterion.classes}>
                          {(item) => (
                            <span class="flex items-center gap-1.5 text-xs text-gray-600">
                              {/* The same swatch the legend draws for this class;
                                  a hollow box when the rule is gone. */}
                              <Swatch
                                spec={
                                  item.rule
                                    ? ruleSwatchSpec(item.rule)
                                    : { kind: "fill", color: "transparent" }
                                }
                                size={SWATCH_SIZE}
                              />
                              {item.name}
                            </span>
                          )}
                        </For>
                      </div>
                    </li>
                  )}
                </For>
              </ul>

              <h4>Legenda</h4>
              <ul class="not-prose flex flex-col gap-1 pl-0">
                <For each={info().legend}>
                  {(item) => (
                    <li class="flex list-none items-center gap-2 text-xs text-gray-600">
                      <Swatch spec={{ kind: "fill", color: item.color }} size={SWATCH_SIZE} />
                      {item.label}
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </>
        )}
      </Show>
    </Show>
  );
}
