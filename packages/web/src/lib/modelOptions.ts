import type { ModelOption, ProviderModelInfo } from "@solace/shared";

/** The sentinel value for the "type an id yourself" row. Not a model id and never sent as one:
 * choosing it reveals a free-text field. It exists because the server's list is "models that
 * exist as far as we could read", which is not the same as "every model you can reach" - a
 * closed dropdown would make an id we failed to enumerate unreachable. */
export const CUSTOM_MODEL_VALUE = "__custom__";

export interface ModelGroup {
  key: string;
  label: string;
  options: ModelOption[];
  /** True for the trailing group of models the provider itself marks as not normally listed. */
  hidden?: boolean;
  /** True for the long-context variants, which sort after the families but before hidden. */
  trailing?: boolean;
}

/**
 * Groups a provider's models by family so thirty ids read as a handful of families with
 * variants, rather than one flat wall. Order is the server's order within a family (which for
 * Codex is Codex's own priority, and for Claude Code is the build's own registry order), and
 * families appear in the order their first model does - no re-ranking by a rule this app
 * invented.
 */
/** Map key for the "not listed by the provider" bucket. Deliberately not a bare "hidden":
 * these keys share a namespace with real family names coming from provider data, so it needs
 * to be something a provider will never emit. It used to be a literal NUL byte, which worked
 * but made git classify this whole file as binary - killing diffs and merges on it. */
const HIDDEN_GROUP_KEY = "__hidden__";

/** Long-context variants sort into their own trailing group rather than doubling the length
 * of every family. They ARE distinct models and the provider's build declares them, so they
 * stay selectable - but "Opus 5" and "Opus 5 (1M context)" sitting next to each other in
 * every family turned a six-item choice into a twelve-item scroll, which is the noise the
 * user objected to. One group at the end says the same thing without paying for it twice. */
const LONG_CONTEXT_GROUP_KEY = "__long_context__";
const LONG_CONTEXT_SUFFIX = "[1m]";

export function groupModels(info: ProviderModelInfo | undefined): ModelGroup[] {
  if (!info) return [];
  const groups = new Map<string, ModelGroup>();
  for (const option of info.models) {
    // Models the source hides live in their own trailing group rather than mixed into a
    // family, so the list stays honest about which ones the provider itself doesn't offer.
    const isLongContext = option.id.endsWith(LONG_CONTEXT_SUFFIX);
    const key = option.hiddenBySource
      ? HIDDEN_GROUP_KEY
      : isLongContext
        ? LONG_CONTEXT_GROUP_KEY
        : option.family;
    const existing = groups.get(key);
    if (existing) existing.options.push(option);
    else
      groups.set(key, {
        key,
        label: option.hiddenBySource
          ? "Not listed by the provider"
          : isLongContext
            ? "Extended context (1M)"
            : option.familyLabel,
        options: [option],
        hidden: option.hiddenBySource || undefined,
        trailing: isLongContext || undefined,
      });
  }
  const all = [...groups.values()];
  return [
    ...all.filter((g) => !g.hidden && !g.trailing),
    ...all.filter((g) => g.trailing && !g.hidden),
    ...all.filter((g) => g.hidden),
  ];
}

export function findModel(info: ProviderModelInfo | undefined, id: string | undefined): ModelOption | undefined {
  if (!info || !id) return undefined;
  return info.models.find((m) => m.id === id);
}

/**
 * The effort levels valid for the model actually selected. Codex states these per model and
 * they genuinely differ between models (one of its 5.6 variants accepts "ultra" and another
 * does not), so a single provider-wide list would offer a level that fails. Falls back to the
 * provider-wide list only for a model the catalog didn't describe - e.g. one the user typed.
 */
export function effortOptionsFor(info: ProviderModelInfo | undefined, modelId?: string): string[] {
  if (!info) return [];
  const perModel = findModel(info, modelId)?.effortLevels;
  const ordered = [info.currentDefaultEffort, ...(perModel ?? info.effortLevels)].filter((v): v is string => Boolean(v));
  // A default recorded from the CLI's config is only a real option if this model accepts it.
  const allowed = perModel ? new Set(perModel) : undefined;
  return [...new Set(ordered)].filter((level) => !allowed || allowed.has(level));
}

/**
 * What the picker should start on for a provider the user just switched to.
 *
 * Only ever the CLI's OWN configured default, read off its config file - and only if that is
 * actually one of the listed ids. Otherwise: nothing, and the picker shows an explicit
 * "Choose a model" prompt.
 *
 * Auto-selecting the first entry looked harmless while the list was three curated aliases. Now
 * that the list is whatever the installed build declares, "first" is an accident of the
 * build's own ordering - it briefly meant a new coding agent defaulted to Fable. Picking a
 * model on the user's behalf needs a basis, and this app does not have one; an unset prompt is
 * the honest state, and it costs one click.
 */
export function initialModelFor(info: ProviderModelInfo | undefined): string {
  if (!info) return "";
  const configured = info.currentDefaultModel;
  return configured && info.models.some((m) => m.id === configured) ? configured : "";
}

/** One sentence naming exactly where a source's ids came from, for the line under the picker.
 * Phrased so that no wording implies the list is an entitlement. */
export function describeSource(kind: string, origin: string): string {
  switch (kind) {
    case "cli-live":
      return `asked live: ${origin}`;
    case "cli-artifact":
      return `read from the installed build: ${origin}`;
    case "account-cache":
      return `from this CLI's own cache for your signed-in account: ${origin}`;
    case "docs":
      return `from documentation: ${origin}`;
    default:
      return origin;
  }
}
