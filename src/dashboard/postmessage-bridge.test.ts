import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parameters,
  resetDashboardState,
  selection,
} from "@/dashboard/dashboard-state";
import { handleDashboardMessage } from "@/dashboard/postmessage-bridge";

beforeEach(() => {
  resetDashboardState();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const noHandlers = {};

describe("handleDashboardMessage", () => {
  it("ignores anything that is not one of ours", () => {
    expect(handleDashboardMessage(null, noHandlers)).toBe(false);
    expect(handleDashboardMessage("dashboard-set", noHandlers)).toBe(false);
    expect(handleDashboardMessage({ type: "map-data" }, noHandlers)).toBe(false);
  });

  it("applies a selection and merges parameters", () => {
    handleDashboardMessage(
      {
        type: "dashboard-set",
        selection: { column: "bu_code", codes: ["GM0882", "BU08820000"] },
        parameters: { jaar: 2026 },
      },
      noHandlers,
    );
    expect(selection()).toEqual({ column: "bu_code", codes: ["GM0882", "BU08820000"] });
    expect(parameters()).toEqual({ jaar: 2026 });

    handleDashboardMessage({ type: "dashboard-set", parameters: { regio: "Noord" } }, noHandlers);
    expect(parameters()).toEqual({ jaar: 2026, regio: "Noord" });

    // A null value drops the key rather than storing null.
    handleDashboardMessage({ type: "dashboard-set", parameters: { jaar: null } }, noHandlers);
    expect(parameters()).toEqual({ regio: "Noord" });
  });

  it("clears the selection on an explicit null and on an empty code list", () => {
    handleDashboardMessage(
      { type: "dashboard-set", selection: { column: "bu_code", codes: ["GM0882"] } },
      noHandlers,
    );
    handleDashboardMessage({ type: "dashboard-set", selection: null }, noHandlers);
    expect(selection()).toBeNull();

    handleDashboardMessage(
      { type: "dashboard-set", selection: { column: "bu_code", codes: [] } },
      noHandlers,
    );
    expect(selection()).toBeNull();
  });

  it("rejects a malformed selection without touching the state", () => {
    handleDashboardMessage(
      { type: "dashboard-set", selection: { column: "bu_code", codes: ["GM0882"] } },
      noHandlers,
    );
    const applied = handleDashboardMessage(
      { type: "dashboard-set", selection: { codes: "GM0882" } },
      noHandlers,
    );
    expect(applied).toBe(false);
    expect(selection()).toEqual({ column: "bu_code", codes: ["GM0882"] });
  });

  it("passes usable table urls to the reload handler", () => {
    const onReloadTables = vi.fn();
    const applied = handleDashboardMessage(
      { type: "dashboard-reload", tables: { buurt: "https://example.test/2027.parquet", leeg: "" } },
      { onReloadTables },
    );
    expect(applied).toBe(true);
    expect(onReloadTables).toHaveBeenCalledWith({ buurt: "https://example.test/2027.parquet" });
  });

  it("ignores a reload with no usable urls", () => {
    const onReloadTables = vi.fn();
    expect(handleDashboardMessage({ type: "dashboard-reload" }, { onReloadTables })).toBe(false);
    expect(onReloadTables).not.toHaveBeenCalled();
  });
});
