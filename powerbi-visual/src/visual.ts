"use strict";

import powerbi from "powerbi-visuals-api";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { parse as parseWkt } from "wellknown";
import type { Feature, Geometry, Position } from "geojson";

import { VisualFormattingSettingsModel } from "./settings";

import IVisual = powerbi.extensibility.visual.IVisual;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
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
    if (event.data && typeof event.data === "object" && event.data.type === "map-ready") {
      this.mapReady = true;
      // Fresh app instance: nothing is on the map yet.
      this.sentLayersLeft = [];
      this.sentLayersRight = [];
      this.sentDatasetPresent = false;
      this.lastZoomKey = "";
      this.sentConfigKey = "";
      this.sentInitialViewKey = "";
      this.reconcile();
    }
  };

  private readonly rootElement: HTMLElement;

  constructor(options: VisualConstructorOptions) {
    this.rootElement = options.element;
    this.rootElement.classList.add("northwake-map-visual");
    this.iframe = document.createElement("iframe");
    this.iframe.setAttribute("title", "Northwake kaart");
    this.rootElement.appendChild(this.iframe);
    window.addEventListener("message", this.onMessage);
  }

  public update(options: VisualUpdateOptions): void {
    // Size the visual explicitly from the host-provided viewport. Relying on CSS
    // height:100% alone leaves the iframe collapsed when the host element has no
    // resolved height, so the map only fills the top-left corner.
    const { width, height } = options.viewport;
    this.rootElement.style.width = `${width}px`;
    this.rootElement.style.height = `${height}px`;

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

    // UI-config overrides (searchbar/navigation/streetview): send on change.
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
  }

  /** Fit the view to the data bbox via the existing map-command view channel. */
  private maybeZoomTo(features: Feature[]): void {
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const f of features) extendBbox((f.geometry as { coordinates?: unknown }).coordinates, bbox);
    if (!Number.isFinite(bbox[0]) || !Number.isFinite(bbox[2])) return;

    const center: [number, number] = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
    const extent = Math.max(bbox[2] - bbox[0], (bbox[3] - bbox[1]) * 2, 0.005);
    const zoom = Math.max(5, Math.min(15, Math.floor(Math.log2(360 / extent))));

    // Only re-zoom when the data extent actually changed — a format-pane tweak
    // resends the dataset but should not yank the user's viewport.
    const key = `${center[0].toFixed(4)},${center[1].toFixed(4)},${zoom}`;
    if (key === this.lastZoomKey) return;
    this.lastZoomKey = key;
    this.post({ type: "map-command", view: { center, zoom } });
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

    const useWkt = geomIdx !== -1;
    if (!useWkt && (lngIdx === -1 || latIdx === -1)) return null;

    const features: Feature[] = [];
    const kindCounts: Record<GeometryKind, number> = { point: 0, line: 0, polygon: 0 };
    let skipped = 0;

    for (const row of table.rows) {
      let geometry: Geometry | null = null;

      if (useWkt) {
        const wkt = row[geomIdx];
        if (typeof wkt === "string" && wkt.length > 0) {
          try {
            geometry = parseWkt(wkt) as Geometry | null;
          } catch {
            geometry = null;
          }
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
