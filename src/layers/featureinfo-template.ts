import type { FeatureInfoConfig } from "./types";

const templateCache = new Map<string, string>();

/** Resolve a template from inline string or fetch from URL (cached). */
export async function resolveTemplate(config: FeatureInfoConfig): Promise<string | null> {
  if (config.template) return config.template;
  if (!config.templateUrl) return null;

  const cached = templateCache.get(config.templateUrl);
  if (cached) return cached;

  const resp = await fetch(config.templateUrl);
  if (!resp.ok) {
    console.warn(`Failed to fetch featureinfo template: ${config.templateUrl}`);
    return null;
  }

  const text = await resp.text();
  templateCache.set(config.templateUrl, text);
  return text;
}

/** Replace [[ param ]] placeholders with feature property values. */
export function renderTemplate(template: string, properties: Record<string, unknown>): string {
  return template.replace(/\[\[\s*([\w.]+)\s*\]\]/g, (_, key) => {
    const val = properties[key];
    return val != null ? String(val) : "";
  });
}
