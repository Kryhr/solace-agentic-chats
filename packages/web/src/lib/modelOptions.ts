import type { ProviderModelInfo } from "@solace/shared";

/** A real, selectable list of model values for a provider - the actual detected current
 * default first (if found), then the known example models, deduplicated. Never includes a
 * blank/"default" placeholder entry; every option is a real model name. */
export function modelOptionsFor(info: ProviderModelInfo | undefined): string[] {
  if (!info) return [];
  const ordered = [info.currentDefaultModel, ...info.modelExamples].filter((v): v is string => Boolean(v));
  return [...new Set(ordered)];
}

export function effortOptionsFor(info: ProviderModelInfo | undefined): string[] {
  if (!info) return [];
  const ordered = [info.currentDefaultEffort, ...info.effortLevels].filter((v): v is string => Boolean(v));
  return [...new Set(ordered)];
}
