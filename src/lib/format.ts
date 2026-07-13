import type { ChartValueFormat } from "@/layers/types";

const nlNumber = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 0 });
const nlCurrency = new Intl.NumberFormat("nl-NL", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});
const nlPercent = new Intl.NumberFormat("nl-NL", {
  style: "percent",
  maximumFractionDigits: 1,
});

/** Format a chart/statistic value for display ("percent" expects a fraction). */
export function formatValue(value: number, format: ChartValueFormat = "number"): string {
  if (!Number.isFinite(value)) return "–";
  switch (format) {
    case "currency":
      return nlCurrency.format(value);
    case "percent":
      return nlPercent.format(value);
    default:
      return nlNumber.format(value);
  }
}

/** "% van totaal" share label, e.g. formatShare(58, 232) -> "25%". */
export function formatShare(value: number, total: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return "0%";
  return new Intl.NumberFormat("nl-NL", {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value / total);
}
