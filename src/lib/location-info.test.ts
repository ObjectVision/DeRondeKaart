import { describe, expect, it } from "vitest";

import type { FeatureInfoResult, PickedFeature } from "@/hooks/use-feature-pick";
import type { LayerEntry } from "@/hooks/use-map-layers";
import type { FeatureInfoConfig } from "@/layers/types";
import { findLocationInfoPick, withoutLayer } from "@/lib/location-info";

const LOCATION = { source: "pc6.parquet", templateUrl: "t.html", keyField: "pc6" };

function entry(id: string, featureinfo?: FeatureInfoConfig): LayerEntry {
  return { config: { id, featureinfo } } as unknown as LayerEntry;
}

function feature(layerConfigId: string, properties: Record<string, unknown> = {}): PickedFeature {
  return { layerConfigId, layerName: layerConfigId, properties };
}

function result(...layers: string[]): FeatureInfoResult {
  return {
    screenX: 0,
    screenY: 0,
    featuresByLayer: new Map(layers.map((id) => [id, [feature(id, { row: 4 })]])),
  };
}

const ENTRIES = [
  entry("pc6_klik", { locationinfo: LOCATION }),
  entry("huisarts", { template: "<b>[[ naam ]]</b>" }),
  entry("buurt_klik", { pbl: true, locationinfo: LOCATION }),
];

describe("findLocationInfoPick", () => {
  it("finds the locationinfo layer and its first feature", () => {
    const pick = findLocationInfoPick(result("huisarts", "pc6_klik"), ENTRIES);
    expect(pick?.layerId).toBe("pc6_klik");
    expect(pick?.config).toBe(LOCATION);
    expect(pick?.feature.properties.row).toBe(4);
  });

  it("ignores template-only layers and lets PBL win", () => {
    expect(findLocationInfoPick(result("huisarts"), ENTRIES)).toBeNull();
    expect(findLocationInfoPick(result("buurt_klik"), ENTRIES)).toBeNull();
  });
});

describe("withoutLayer", () => {
  it("keeps the other layers, or returns null when there are none", () => {
    expect([...withoutLayer(result("pc6_klik", "huisarts"), "pc6_klik")!.featuresByLayer.keys()]).toEqual([
      "huisarts",
    ]);
    expect(withoutLayer(result("pc6_klik"), "pc6_klik")).toBeNull();
  });
});
