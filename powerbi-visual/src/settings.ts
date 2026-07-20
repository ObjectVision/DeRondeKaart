"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

import FormattingSettingsCard = formattingSettings.SimpleCard;
import FormattingSettingsModel = formattingSettings.Model;

/** Default hosted map app URL (override per report in the format pane). */
export const DEFAULT_APP_URL = "https://map.woonzorglimburg.nl/app/";

/** Kaart (map) settings: app URL, predefined layers.json layers, auto zoom. */
export class MapCardSettings extends FormattingSettingsCard {
  appUrl = new formattingSettings.TextInput({
    name: "appUrl",
    displayName: "App-URL",
    description: "URL van de gehoste kaartapplicatie",
    value: DEFAULT_APP_URL,
    placeholder: DEFAULT_APP_URL,
  });

  layersLeft = new formattingSettings.TextInput({
    name: "layersLeft",
    displayName: "Lagen linker kaart",
    description: "Komma-gescheiden laag-id's uit layers.json voor de linker kaart",
    value: "",
    placeholder: "bijv. huisarts,supermarkt",
  });

  layersRight = new formattingSettings.TextInput({
    name: "layersRight",
    displayName: "Lagen rechter kaart",
    description: "Komma-gescheiden laag-id's uit layers.json voor de rechter kaart",
    value: "",
    placeholder: "bijv. loopafstand_huisarts",
  });

  autoZoom = new formattingSettings.ToggleSwitch({
    name: "autoZoom",
    displayName: "Automatisch zoomen",
    description: "Zoom naar de omvang van de Power BI-data bij elke update",
    value: true,
  });

  name: string = "map";
  displayName: string = "Kaart";
  slices: Array<formattingSettings.Slice> = [
    this.appUrl,
    this.layersLeft,
    this.layersRight,
    this.autoZoom,
  ];
}

/**
 * UI / view overrides — mirror the map.json flags. Sent to the app as a
 * `map-config` message (searchbar/navigation/streetview) and, when
 * "Beginweergave instellen" is on, an initial center/zoom `view` command.
 */
export class MapViewCardSettings extends FormattingSettingsCard {
  searchbar = new formattingSettings.ToggleSwitch({
    name: "searchbar",
    displayName: "Zoekbalk",
    description: "Toon de zoekbalk (overschrijft map.json)",
    value: false,
  });

  navigation = new formattingSettings.ToggleSwitch({
    name: "navigation",
    displayName: "Navigatie",
    description: "Toon de navigatieknoppen en categorierij (overschrijft map.json)",
    value: false,
  });

  share = new formattingSettings.ToggleSwitch({
    name: "share",
    displayName: "Share",
    description: "Zet deel-functionality aan of uit (overschrijft map.json)",
    value: false,
  });

  annotations = new formattingSettings.ToggleSwitch({
    name: "annotations",
    displayName: "Annotations",
    description: "Zet annotatie functionaliteit aan of uit (overschrijft map.json)",
    value: false,
  });

  streetview = new formattingSettings.ToggleSwitch({
    name: "streetview",
    displayName: "Street View",
    description: "Open Street View bij klikken op de kaart (overschrijft map.json)",
    value: false,
  });

  setInitialView = new formattingSettings.ToggleSwitch({
    name: "setInitialView",
    displayName: "Beginweergave instellen",
    description:
      "Gebruik de onderstaande lengte-/breedtegraad en zoom als beginweergave (in plaats van map.json / automatisch zoomen)",
    value: false,
  });

  initialLongitude = new formattingSettings.NumUpDown({
    name: "initialLongitude",
    displayName: "Lengtegraad",
    value: 5.788,
  });

  initialLatitude = new formattingSettings.NumUpDown({
    name: "initialLatitude",
    displayName: "Breedtegraad",
    value: 51.093,
  });

  initialZoom = new formattingSettings.NumUpDown({
    name: "initialZoom",
    displayName: "Zoom",
    value: 8,
  });

  name: string = "mapView";
  displayName: string = "Kaartweergave";
  slices: Array<formattingSettings.Slice> = [
    this.searchbar,
    this.navigation,
    this.streetview,
    this.share,
    this.annotations,
    this.setInitialView,
    this.initialLongitude,
    this.initialLatitude,
    this.initialZoom,
  ];
}

/** Point style for the dynamic Power BI data layer. */
export class PointStyleCardSettings extends FormattingSettingsCard {
  fillColor = new formattingSettings.ColorPicker({
    name: "fillColor",
    displayName: "Vulkleur",
    value: { value: "#863bff" },
  });

  radius = new formattingSettings.NumUpDown({
    name: "radius",
    displayName: "Straal (px)",
    value: 6,
  });

  opacity = new formattingSettings.Slider({
    name: "opacity",
    displayName: "Doorzichtigheid (%)",
    value: 90,
    options: {
      minValue: { type: 0 /* ValidatorType.Min */, value: 0 },
      maxValue: { type: 1 /* ValidatorType.Max */, value: 100 },
    },
  });

  name: string = "pointStyle";
  displayName: string = "Puntstijl";
  slices: Array<formattingSettings.Slice> = [this.fillColor, this.radius, this.opacity];
}

/** Line style for the dynamic Power BI data layer. */
export class LineStyleCardSettings extends FormattingSettingsCard {
  color = new formattingSettings.ColorPicker({
    name: "color",
    displayName: "Lijnkleur",
    value: { value: "#2b8cbe" },
  });

  width = new formattingSettings.NumUpDown({
    name: "width",
    displayName: "Breedte (px)",
    value: 2,
  });

  opacity = new formattingSettings.Slider({
    name: "opacity",
    displayName: "Doorzichtigheid (%)",
    value: 90,
    options: {
      minValue: { type: 0, value: 0 },
      maxValue: { type: 1, value: 100 },
    },
  });

  name: string = "lineStyle";
  displayName: string = "Lijnstijl";
  slices: Array<formattingSettings.Slice> = [this.color, this.width, this.opacity];
}

/** Polygon style for the dynamic Power BI data layer. */
export class PolygonStyleCardSettings extends FormattingSettingsCard {
  fillColor = new formattingSettings.ColorPicker({
    name: "fillColor",
    displayName: "Vulkleur",
    value: { value: "#863bff" },
  });

  outlineColor = new formattingSettings.ColorPicker({
    name: "outlineColor",
    displayName: "Randkleur",
    value: { value: "#4b2999" },
  });

  outlineWidth = new formattingSettings.NumUpDown({
    name: "outlineWidth",
    displayName: "Randbreedte (px)",
    value: 1,
  });

  opacity = new formattingSettings.Slider({
    name: "opacity",
    displayName: "Doorzichtigheid (%)",
    value: 70,
    options: {
      minValue: { type: 0, value: 0 },
      maxValue: { type: 1, value: 100 },
    },
  });

  name: string = "polygonStyle";
  displayName: string = "Polygoonstijl";
  slices: Array<formattingSettings.Slice> = [
    this.fillColor,
    this.outlineColor,
    this.outlineWidth,
    this.opacity,
  ];
}

export class VisualFormattingSettingsModel extends FormattingSettingsModel {
  mapCard = new MapCardSettings();
  mapViewCard = new MapViewCardSettings();
  pointStyleCard = new PointStyleCardSettings();
  lineStyleCard = new LineStyleCardSettings();
  polygonStyleCard = new PolygonStyleCardSettings();

  cards = [
    this.mapCard,
    this.mapViewCard,
    this.pointStyleCard,
    this.lineStyleCard,
    this.polygonStyleCard,
  ];
}
