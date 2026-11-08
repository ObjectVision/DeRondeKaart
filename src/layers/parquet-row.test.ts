import { afterEach, describe, expect, it, vi } from "vitest";
import { tableFromArrays, tableToIPC } from "apache-arrow";

/**
 * parquet-wasm is replaced by a fake whose `read({ offset, limit })` slices an
 * in-memory Arrow table — enough to check the row lookup, the caches and the
 * value conversion without a wasm build or a network.
 */
const source = tableFromArrays({
  pc6: ["6211AA", "6211AB", "6211AC"],
  n: BigInt64Array.from([1n, 2n, 3n]),
  geometry: Float64Array.from([0, 0, 0]),
});

const fromUrl = vi.fn();
const read = vi.fn(async (options: { offset: number; limit: number }) => {
  const slice = source.slice(options.offset, options.offset + options.limit);
  return { intoIPCStream: () => tableToIPC(slice, "stream") };
});

vi.mock("@/vendor/parquet-wasm/parquet_wasm.js", () => ({
  default: vi.fn(async () => {}),
  readParquet: vi.fn(),
  readParquetStream: vi.fn(),
  ParquetFile: { fromUrl: (url: string) => fromUrl(url) },
}));

const { fetchParquetRow, clearParquetRowCache } = await import("@/layers/parquet-row");

afterEach(() => {
  clearParquetRowCache();
  fromUrl.mockReset();
  read.mockClear();
});

describe("fetchParquetRow", () => {
  it("returns the row at the index, as plain values, without geometry", async () => {
    fromUrl.mockResolvedValue({ read });
    await expect(fetchParquetRow("a.parquet", 1)).resolves.toEqual({ pc6: "6211AB", n: 2 });
    expect(read).toHaveBeenCalledWith({ offset: 1, limit: 1 });
  });

  it("returns null past the last row", async () => {
    fromUrl.mockResolvedValue({ read });
    await expect(fetchParquetRow("a.parquet", 3)).resolves.toBeNull();
  });

  it("opens each file once and serves a repeated row from cache", async () => {
    fromUrl.mockResolvedValue({ read });
    await Promise.all([fetchParquetRow("a.parquet", 0), fetchParquetRow("a.parquet", 2)]);
    await fetchParquetRow("a.parquet", 0);
    expect(fromUrl).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed open, so the next click retries", async () => {
    fromUrl.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ read });
    await expect(fetchParquetRow("b.parquet", 0)).rejects.toThrow("offline");
    await expect(fetchParquetRow("b.parquet", 0)).resolves.toMatchObject({ pc6: "6211AA" });
    expect(fromUrl).toHaveBeenCalledTimes(2);
  });
});
