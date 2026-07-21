"use strict";

import powerbi from "powerbi-visuals-api";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { parseWkbBase64 } from "./wkb";
import type { Feature, Geometry, Position } from "geojson";

import { VisualFormattingSettingsModel } from "./settings";

import IVisual = powerbi.extensibility.visual.IVisual;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisualEventService = powerbi.extensibility.IVisualEventService;
import DataView = powerbi.DataView;

type GeometryKind = "point" | "line" | "polygon";

/** Flat style understood by the map app (mirrors the app's LayerStyle). */
interface AppLayerStyle {
  color?: [number, number, number, number];
  lineColor?: [number, number, number, number];
  opacity?: number;
  radius?: number;
  lineWidth?: number;
  filled?: boolean;
  stroked?: boolean;
}

interface MapDataset {
  id: string;
  name?: string;
  geometryType?: GeometryKind;
  style?: AppLayerStyle;
  features: Feature[];
}

/** Runtime UI-config overrides sent to the app as a `map-config` message. */
interface MapUiConfig {
  searchbar?: boolean;
  navigation?: boolean;
  streetview?: boolean;
  share?: boolean;
  annotations?: boolean;
}

/** Stable id of the dynamic Power BI layer inside the map app. */
const DATA_LAYER_ID = "powerbi-data";

function hexToRgba(hex: string, opacityPct: number): [number, number, number, number] {
  const h = (hex || "#0080ff").replace("#", "");
  const r = parseInt(h.substring(0, 2), 16) || 0;
  const g = parseInt(h.substring(2, 4), 16) || 0;
  const b = parseInt(h.substring(4, 6), 16) || 0;
  const a = Math.round(Math.max(0, Math.min(100, opacityPct)) * 2.55);
  return [r, g, b, a];
}

function geometryKind(geometry: Geometry): GeometryKind {
  switch (geometry.type) {
    case "LineString":
    case "MultiLineString":
      return "line";
    case "Polygon":
    case "MultiPolygon":
      return "polygon";
    default:
      return "point";
  }
}

/** Walk any GeoJSON coordinates array, extending the bbox in place. */
function extendBbox(coords: unknown, bbox: number[]): void {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === "number") {
    const [lng, lat] = coords as Position;
    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      bbox[0] = Math.min(bbox[0], lng);
      bbox[1] = Math.min(bbox[1], lat);
      bbox[2] = Math.max(bbox[2], lng);
      bbox[3] = Math.max(bbox[3], lat);
    }
    return;
  }
  for (const c of coords) extendBbox(c, bbox);
}

export class Visual implements IVisual {
  private readonly formattingSettingsService = new FormattingSettingsService();
  private formattingSettings: VisualFormattingSettingsModel =
    new VisualFormattingSettingsModel();

  private readonly iframe: HTMLIFrameElement;
  private readonly snapshotImg: HTMLImageElement;
  private readonly events: IVisualEventService;
  private currentAppUrl = "";
  private mapReady = false;

  // Desired state (recomputed on every update) vs. what has been sent, so a
  // map reload (map-ready) can re-sync everything declaratively.
  private desiredLayersLeft: string[] = [];
  private desiredLayersRight: string[] = [];
  private desiredDataset: MapDataset | null = null;
  private autoZoom = true;
  private desiredConfig: MapUiConfig = {};
  private desiredInitialView: { center: [number, number]; zoom: number } | null = null;

  private sentLayersLeft: string[] = [];
  private sentLayersRight: string[] = [];
  private sentDatasetPresent = false;
  private lastZoomKey = "";
  private sentConfigKey = "";
  private sentInitialViewKey = "";

  private readonly onMessage = (event: MessageEvent): void => {
    if (event.source !== this.iframe.contentWindow) return;
    if (!event.data || typeof event.data !== "object") return;
    if (event.data.type === "map-ready") {
      this.mapReady = true;
      // Fresh app instance: nothing is on the map yet.
      this.sentLayersLeft = [];
      this.sentLayersRight = [];
      this.sentDatasetPresent = false;
      this.lastZoomKey = "";
      this.sentConfigKey = "";
      this.sentInitialViewKey = "";
      this.reconcile();
    } else if (event.data.type === "map-snapshot") {
      // Latest rendered frame from the app. Painted into our own DOM (under
      // the iframe) so Power BI's PDF/PPT export — which rasterizes the
      // cross-origin iframe blank — shows the map. See style/visual.less.
      const dataUrl = event.data.dataUrl;
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
        this.snapshotImg.src = dataUrl;
      }
    }
  };

  private readonly rootElement: HTMLElement;

  constructor(options: VisualConstructorOptions) {
    this.events = options.host.eventService;
    this.rootElement = options.element;
    this.rootElement.classList.add("northwake-map-visual");
    this.rootElement.style.position = "relative";
    this.rootElement.style.overflow = "hidden";

    // Both layers are absolutely positioned and sized IN PX from the viewport
    // (see update()) — not via CSS %, which collapses when the sandbox host has
    // no resolved height (was rendering both at intrinsic size, side by side).
    // The snapshot sits behind (z-index 0, non-interactive) for PDF/PPT export;
    // the live iframe is on top (z-index 1) and receives all interaction.
    this.snapshotImg = document.createElement("img");
    this.snapshotImg.className = "map-snapshot";
    this.snapshotImg.alt = "";
    this.snapshotImg.style.cssText =
      "position:absolute;top:0;left:0;object-fit:cover;display:block;z-index:0;pointer-events:none;";
    this.rootElement.appendChild(this.snapshotImg);
    this.iframe = document.createElement("iframe");
    this.iframe.setAttribute("title", "Northwake kaart");
    this.iframe.style.cssText =
      "position:absolute;top:0;left:0;border:0;display:block;z-index:1;";
    this.rootElement.appendChild(this.iframe);
    window.addEventListener("message", this.onMessage);
  }

  public update(options: VisualUpdateOptions): void {
    // Signal render start/finish so Power BI marks the visual export-capable —
    // without these events the host refuses PDF/PPT export ("biedt geen
    // ondersteuning voor exporteren"). renderingFinished only flips that flag;
    // the exported pixels come from snapshotImg (kept current by the app's
    // map-snapshot handshake), so it need not await the async iframe/snapshot.
    this.events.renderingStarted(options);
    try {
      this.render(options);
      this.events.renderingFinished(options);
    } catch (e) {
      this.events.renderingFailed(options, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  private render(options: VisualUpdateOptions): void {
    // Size host + both layers explicitly in PX from the viewport. Relying on
    // CSS % collapses inside the sandbox (no resolved parent height) and left
    // the iframe/img at intrinsic size, tiled side by side. Setting px on all
    // three makes them one overlaid, viewport-filling box — no split, no gap.
    const vp = options.viewport;
    const w = `${vp.width}px`;
    const h = `${vp.height}px`;
    this.rootElement.style.width = w;
    this.rootElement.style.height = h;
    this.iframe.style.width = w;
    this.iframe.style.height = h;
    this.snapshotImg.style.width = w;
    this.snapshotImg.style.height = h;

    const dataView: DataView | undefined = options.dataViews && options.dataViews[0];
    this.formattingSettings =
      this.formattingSettingsService.populateFormattingSettingsModel(
        VisualFormattingSettingsModel,
        dataView,
      );

    const map = this.formattingSettings.mapCard;
    const appUrl = (map.appUrl.value || "").trim();
    if (appUrl && appUrl !== this.currentAppUrl) {
      this.currentAppUrl = appUrl;
      this.mapReady = false;
      this.iframe.src = appUrl;
    }

    this.autoZoom = map.autoZoom.value;
    this.desiredLayersLeft = parseIdList(map.layersLeft.value);
    this.desiredLayersRight = parseIdList(map.layersRight.value);
    this.desiredDataset = this.buildDataset(dataView);

    const view = this.formattingSettings.mapViewCard;
    this.desiredConfig = {
      searchbar: view.searchbar.value,
      navigation: view.navigation.value,
      streetview: view.streetview.value,
      share: view.share.value,
      annotations: view.annotations.value,
    };
    this.desiredInitialView = view.setInitialView.value
      ? {
          center: [Number(view.initialLongitude.value), Number(view.initialLatitude.value)],
          zoom: Number(view.initialZoom.value),
        }
      : null;

    this.reconcile();
  }

  public getFormattingModel(): powerbi.visuals.FormattingModel {
    return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
  }

  public destroy(): void {
    window.removeEventListener("message", this.onMessage);
  }

  // ---------------------------------------------------------------- reconcile

  private post(message: unknown): void {
    this.iframe.contentWindow?.postMessage(message, "*");
  }

  /** Push the desired state to the map app (only when it is ready). */
  private reconcile(): void {
    if (!this.mapReady) return;

    // UI-config overrides (searchbar/navigation/streetview/share/annotations): send on change.
    const configKey = JSON.stringify(this.desiredConfig);
    if (configKey !== this.sentConfigKey) {
      this.post({ type: "map-config", ...this.desiredConfig });
      this.sentConfigKey = configKey;
    }

    // Explicit initial view overrides auto-zoom-to-data; send on change.
    if (this.desiredInitialView) {
      const key = JSON.stringify(this.desiredInitialView);
      if (key !== this.sentInitialViewKey) {
        this.post({ type: "map-command", view: this.desiredInitialView });
        this.sentInitialViewKey = key;
      }
    } else {
      this.sentInitialViewKey = "";
    }

    // layers.json layers: diff per map side against what was already sent.
    const commands: Array<{ cmd: "add" | "remove"; map: "a" | "b"; layer: string }> = [];
    diffLayers(this.sentLayersLeft, this.desiredLayersLeft, "a", commands);
    diffLayers(this.sentLayersRight, this.desiredLayersRight, "b", commands);
    if (commands.length > 0) {
      this.post({ type: "map-command", commands });
      this.sentLayersLeft = [...this.desiredLayersLeft];
      this.sentLayersRight = [...this.desiredLayersRight];
    }

    // Dynamic dataset: resend in full (replace-on-update semantics app-side).
    if (this.desiredDataset) {
      this.post({ type: "map-data", dataset: this.desiredDataset });
      this.sentDatasetPresent = true;
      // Auto-zoom to data unless an explicit initial view is configured.
      if (this.autoZoom && !this.desiredInitialView) {
        this.maybeZoomTo(this.desiredDataset.features);
      }
    } else if (this.sentDatasetPresent) {
      this.post({ type: "map-data-remove", id: DATA_LAYER_ID });
      this.sentDatasetPresent = false;
    }

    // Ask for a fresh snapshot once the pushed state settles (the app also
    // refreshes it on map idle; this covers config/data-only changes).
    this.post({ type: "request-snapshot" });
  }

  /**
   * Fit the view to the data bbox via the map-command view channel. The bbox
   * is resolved to a center/zoom APP-side (viewForBbox in src/lib/fly-to.ts)
   * — the one shared implementation, also used by the filter fly-to — so no
   * zoom heuristic is duplicated here.
   */
  private maybeZoomTo(features: Feature[]): void {
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const f of features) extendBbox((f.geometry as { coordinates?: unknown }).coordinates, bbox);
    if (!Number.isFinite(bbox[0]) || !Number.isFinite(bbox[2])) return;

    // Only re-zoom when the data extent actually changed — a format-pane tweak
    // resends the dataset but should not yank the user's viewport.
    const key = bbox.map((v) => v.toFixed(4)).join(",");
    if (key === this.lastZoomKey) return;
    this.lastZoomKey = key;
    this.post({ type: "map-command", view: { bbox } });
  }

  // ------------------------------------------------------------- data mapping

  /** Transform the table DataView into GeoJSON features + style. */
  private buildDataset(dataView: DataView | undefined): MapDataset | null {
    const table = dataView?.table;
    if (!table || !table.rows || table.rows.length === 0) return null;

    const columns = table.columns || [];
    let geomIdx = -1;
    let lngIdx = -1;
    let latIdx = -1;
    const tooltipIdxs: number[] = [];

    for (let i = 0; i < columns.length; i++) {
      const roles = columns[i].roles || {};
      if (roles.geometry && geomIdx === -1) geomIdx = i;
      if (roles.longitude && lngIdx === -1) lngIdx = i;
      if (roles.latitude && latIdx === -1) latIdx = i;
      if (roles.tooltips) tooltipIdxs.push(i);
    }

    const useGeom = geomIdx !== -1;
    if (!useGeom && (lngIdx === -1 || latIdx === -1)) return null;

    // Diagnostic: reveal which geometry path is active and a sample of the raw
    // cell values/types, so skipped-row causes are visible instead of guessed.
    // eslint-disable-next-line no-console
    const sampleGeom = table.rows[0]?.[geomIdx];
    console.log(
      "[nwviz] buildDataset",
      { useGeom, geomIdx, lngIdx, latIdx, rows: table.rows.length },
      useGeom
        ? {
            type: typeof sampleGeom,
            length: typeof sampleGeom === "string" ? sampleGeom.length : undefined,
            head: typeof sampleGeom === "string" ? sampleGeom.slice(0, 16) : sampleGeom,
          }
        : {
            lngRaw: table.rows[0]?.[lngIdx],
            lngType: typeof table.rows[0]?.[lngIdx],
            latRaw: table.rows[0]?.[latIdx],
            latType: typeof table.rows[0]?.[latIdx],
          },
    );

    const features: Feature[] = [];
    const kindCounts: Record<GeometryKind, number> = { point: 0, line: 0, polygon: 0 };
    let skipped = 0;

    for (const row of table.rows) {
      let geometry: Geometry | null = null;

      if (useGeom) {
        const cell = row[geomIdx];
        if (typeof cell === "string" && cell.length > 0) {
          geometry = parseWkbBase64(cell);
        }
      } else {
        const lng = Number(row[lngIdx]);
        const lat = Number(row[latIdx]);
        if (Number.isFinite(lng) && Number.isFinite(lat)) {
          geometry = { type: "Point", coordinates: [lng, lat] };
        }
      }

      if (!geometry) {
        skipped++;
        continue;
      }

      const properties: Record<string, unknown> = {};
      for (const ti of tooltipIdxs) {
        properties[columns[ti].displayName] = row[ti];
      }

      kindCounts[geometryKind(geometry)]++;
      features.push({ type: "Feature", geometry, properties });
    }

    if (skipped > 0) {
      console.warn(`northwake visual: ${skipped} row(s) without valid geometry skipped`);
    }
    if (features.length === 0) return null;

    const dominant: GeometryKind =
      kindCounts.polygon >= kindCounts.line && kindCounts.polygon >= kindCounts.point
        ? "polygon"
        : kindCounts.line >= kindCounts.point
          ? "line"
          : "point";

    return {
      id: DATA_LAYER_ID,
      name: "Power BI data",
      geometryType: dominant,
      style: this.buildStyle(dominant),
      features,
    };
  }

  /** Map the three format-pane style cards onto the app's flat LayerStyle. */
  private buildStyle(kind: GeometryKind): AppLayerStyle {
    const point = this.formattingSettings.pointStyleCard;
    const line = this.formattingSettings.lineStyleCard;
    const polygon = this.formattingSettings.polygonStyleCard;

    if (kind === "line") {
      return {
        color: hexToRgba(line.color.value.value, line.opacity.value),
        lineWidth: line.width.value,
        filled: false,
        stroked: true,
      };
    }
    if (kind === "polygon") {
      return {
        color: hexToRgba(polygon.fillColor.value.value, polygon.opacity.value),
        lineColor: hexToRgba(polygon.outlineColor.value.value, polygon.opacity.value),
        lineWidth: polygon.outlineWidth.value,
        filled: true,
        stroked: true,
      };
    }
    return {
      color: hexToRgba(point.fillColor.value.value, point.opacity.value),
      radius: point.radius.value,
      filled: true,
      stroked: false,
    };
  }
}

function parseIdList(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function diffLayers(
  sent: string[],
  desired: string[],
  map: "a" | "b",
  out: Array<{ cmd: "add" | "remove"; map: "a" | "b"; layer: string }>,
): void {
  for (const id of desired) {
    if (!sent.includes(id)) out.push({ cmd: "add", map, layer: id });
  }
  for (const id of sent) {
    if (!desired.includes(id)) out.push({ cmd: "remove", map, layer: id });
  }
}
