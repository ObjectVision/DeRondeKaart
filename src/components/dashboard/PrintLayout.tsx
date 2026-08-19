import { Show, type JSX } from "solid-js";

import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import type { DashboardExportLayout } from "@/dashboard/layout-config";
import type { ResolvedWidget } from "@/dashboard/resolve-widgets";

interface PrintLayoutProps {
  layout: DashboardExportLayout;
  widgets: ResolvedWidget[];
}

/**
 * The PDF export: a second render of the widgets that only exists on paper.
 *
 * Export goes through `window.print()` rather than a PDF library — the charts
 * are already SVG and the tiles are already DOM, so the browser's own engine
 * produces vector output with no new dependency.
 *
 * The `@page` rule is injected here rather than living in `index.css` because
 * page size and orientation come from `dashboard_export.json`; a stylesheet
 * cannot take them as a variable.
 */
export function PrintLayout(props: PrintLayoutProps): JSX.Element {
  const pageRule = () =>
    `@page { size: ${props.layout.pageSize} ${props.layout.orientation}; margin: 14mm; }`;

  return (
    <>
      <style>
        {pageRule()}
        {`
        .dashboard-print { display: none; }
        @media print {
          .dashboard-screen { display: none !important; }
          .dashboard-print { display: block; }
          /* Keep a tile from being split across two pages. */
          .dashboard-print .grid > * { break-inside: avoid; }
        }
        `}
      </style>
      <div class="dashboard-print">
        <Show when={props.layout.title}>
          {(title) => <h1 class="mb-1 text-xl font-bold text-gray-900">{title()}</h1>}
        </Show>
        <Show when={props.layout.subtitle}>
          {(subtitle) => <p class="mb-4 text-sm text-gray-600">{subtitle()}</p>}
        </Show>
        <DashboardGrid columns={props.layout.columns} widgets={props.widgets} />
      </div>
    </>
  );
}
