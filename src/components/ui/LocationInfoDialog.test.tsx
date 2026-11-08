import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";

import type { FeatureInfoResult } from "@/hooks/use-feature-pick";
import type { LayerEntry } from "@/hooks/use-map-layers";

const fetchParquetRow = vi.fn();
vi.mock("@/layers/parquet-row", () => ({
  fetchParquetRow: (url: string, row: number) => fetchParquetRow(url, row),
}));
// The real panel loads the Google Maps API; only its presence matters here.
vi.mock("@/components/ui/street-view", () => ({
  StreetView: () => <div data-testid="streetview" />,
}));

const { LocationInfoDialog } = await import("@/components/ui/LocationInfoDialog");

const TEMPLATE = `
  <div data-locationinfo="general"><span class="adres">[[ pc6 | postcode ]] [[ woonplaats ]]</span></div>
  <section data-tab="gebouw" data-label="Gebouw"><p class="bouwjaar">[[ bouwjaar ]]</p></section>
  <section data-tab="bewoners" data-label="Bewoners"><p class="oosr">[[ oosr ]]</p></section>
  <p data-locationinfo="footer">voetnoot</p>`;

/** Each case its own template URL: resolveTemplate caches per URL for the whole file. */
let caseNo = 0;

function setup(options: { others?: boolean; rowPc6?: string; streetView?: boolean } = {}) {
  const templateUrl = `https://example.test/t${++caseNo}.html`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, statusText: "OK", text: async () => TEMPLATE })),
  );
  fetchParquetRow.mockResolvedValue({
    pc6: options.rowPc6 ?? "6211AB",
    woonplaats: "Maastricht",
    bouwjaar: "1970-1980",
    oosr: 3,
  });

  const entries = [
    {
      config: {
        id: "pc6_klik",
        name: "Locatie informatie",
        featureinfo: { locationinfo: { source: "pc6.parquet", templateUrl, keyField: "pc6" } },
      },
    },
    { config: { id: "huisarts", name: "Huisarts", featureinfo: { template: "<b>[[ naam ]]</b>" } } },
  ] as unknown as LayerEntry[];

  const featuresByLayer: FeatureInfoResult["featuresByLayer"] = new Map([
    ["pc6_klik", [{ layerConfigId: "pc6_klik", layerName: "Locatie informatie", properties: { row: 7, pc6: "6211AB" } }]],
  ]);
  if (options.others) {
    featuresByLayer.set("huisarts", [
      { layerConfigId: "huisarts", layerName: "Huisarts", properties: { naam: "Dokter De Boer" } },
    ]);
  }
  const result: FeatureInfoResult = { screenX: 0, screenY: 0, featuresByLayer };
  const onClose = vi.fn();
  render(() => (
    <LocationInfoDialog
      result={result}
      layerEntries={entries}
      streetView={options.streetView ? { lng: 5.7, lat: 50.85 } : null}
      onClose={onClose}
    />
  ));
  return { onClose };
}

function tabLabels(): string[] {
  return Array.from(document.querySelectorAll('button[role="tab"]')).map((t) => t.textContent ?? "");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchParquetRow.mockReset();
});

describe("LocationInfoDialog", () => {
  it("fills the general block and the first tab from the clicked row", async () => {
    setup();
    await vi.waitFor(() => expect(document.querySelector(".adres")?.textContent).toBe("6211 AB Maastricht"));
    expect(fetchParquetRow).toHaveBeenCalledWith("pc6.parquet", 7);
    expect(tabLabels()).toEqual(["Gebouw", "Bewoners"]);
    expect(document.querySelector(".bouwjaar")?.textContent).toBe("1970-1980");
    expect(document.body.textContent).toContain("voetnoot");
    expect(document.querySelector('[data-testid="streetview"]')).toBeNull();
  });

  it("switches tabs and shows the other layers under Kaartlagen", async () => {
    setup({ others: true, streetView: true });
    await vi.waitFor(() => expect(tabLabels()).toEqual(["Gebouw", "Bewoners", "layersKaartlagen"]));
    expect(document.querySelector('[data-testid="streetview"]')).toBeTruthy();

    fireEvent.click(document.querySelectorAll('button[role="tab"]')[1]);
    expect(document.querySelector(".oosr")?.textContent).toBe("3");

    fireEvent.click(document.querySelectorAll('button[role="tab"]')[2]);
    await vi.waitFor(() => expect(document.body.textContent).toContain("Dokter De Boer"));
  });

  it("refuses a row whose key does not match the clicked feature", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setup({ rowPc6: "6211ZZ" });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Locatie-informatie kon niet worden geladen"),
    );
    expect(document.querySelector(".bouwjaar")).toBeNull();
  });

  it("closes through the close button", async () => {
    const { onClose } = setup();
    fireEvent.click(document.querySelector('button[aria-label="Sluiten"]')!);
    expect(onClose).toHaveBeenCalled();
  });
});
