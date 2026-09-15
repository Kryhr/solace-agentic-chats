import { useState } from "react";
import type { ProviderModelInfo } from "@solace/shared";
import { CUSTOM_MODEL_VALUE, describeSource, findModel, groupModels } from "../lib/modelOptions";

/**
 * The model control, shared by Add Agent and the agent hub so switching an existing agent
 * between (say) two Opus variants is the same act as choosing one at creation.
 *
 * Three things this deliberately does, all of them about not overclaiming:
 *
 *  1. It groups by family. Six Opus builds in a flat list of ids is not a choice anyone can
 *     make; "Opus" with six dated variants under it is.
 *  2. It always offers "Other model id…". The server's list is everything this machine could
 *     genuinely read, which is not a guarantee of completeness - a closed dropdown would make
 *     an id we failed to enumerate unreachable.
 *  3. It never says "available to you". It says where the list came from and, in
 *     ModelSourceNote, that whether your plan can run a given model is not knowable from here.
 *     The only honest test is to run a turn; if the provider refuses, its own words are shown
 *     verbatim on the agent (AgentStatus.lastError).
 */
export function ModelPicker({
  info,
  value,
  onChange,
  label = "Model",
}: {
  info: ProviderModelInfo | undefined;
  value: string;
  onChange: (model: string) => void;
  label?: string;
}) {
  const groups = groupModels(info);
  const known = findModel(info, value);
  // A value that isn't in the list is a real choice the user made (typed, or saved before the
  // CLI changed), so the field opens in custom mode showing it rather than snapping to
  // something they didn't pick.
  const [custom, setCustom] = useState(Boolean(value) && !known);

  if (groups.length === 0 && !custom) {
    return (
      <label>
        {label}
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="model id"
          spellCheck={false}
          autoCapitalize="off"
        />
      </label>
    );
  }

  return (
    <>
      <label>
        {label}
        <select
          className="select"
          value={custom ? CUSTOM_MODEL_VALUE : value}
          onChange={(e) => {
            if (e.target.value === CUSTOM_MODEL_VALUE) {
              setCustom(true);
              return;
            }
            setCustom(false);
            onChange(e.target.value);
          }}
        >
          {/* An unset prompt, not a fabricated default. The app has no basis for choosing one
              model over another, so it asks rather than deciding - see initialModelFor. */}
          {!value && !custom && (
            <option value="" disabled>
              Choose a model…
            </option>
          )}
          {groups.map((group) => (
            <optgroup key={group.key} label={group.label}>
              {group.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {/* The id is always shown: it is the thing actually passed to --model, and a
                      pretty name alone would hide which concrete build an alias points at. */}
                  {option.label === option.id ? option.id : `${option.label} — ${option.id}`}
                  {option.aliasFor ? ` → ${option.aliasFor}` : ""}
                </option>
              ))}
            </optgroup>
          ))}
          <option value={CUSTOM_MODEL_VALUE}>Other model id…</option>
        </select>
      </label>
      {custom && (
        <label>
          Model id
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="type any id this provider accepts"
            spellCheck={false}
            autoCapitalize="off"
            autoFocus
          />
        </label>
      )}
      {known?.aliasFor && (
        <div className="model-note">
          <strong>{known.id}</strong> is an alias, not a model. The installed CLI currently maps it to{" "}
          <code>{known.aliasFor}</code> — and the provider can change that mapping without telling this app.
        </div>
      )}
      {known?.note && !known.aliasFor && <div className="model-note">{known.note}</div>}
    </>
  );
}

/**
 * The provenance line. Shown wherever there is room for it, because a model list with no
 * stated origin is a claim with no evidence - and because the difference between "Codex told
 * us this just now" and "we read this out of the .exe on disk" is a difference the user is
 * entitled to see.
 */
export function ModelSourceNote({ info }: { info: ProviderModelInfo | undefined }) {
  if (!info) return null;
  return (
    <div className="field-note model-source-note">
      {info.models.length > 0 && (
        <p>
          {info.models.length} model{info.models.length === 1 ? "" : "s"} listed. These are models that{" "}
          <strong>exist</strong>. Nothing here can tell you whether your subscription may run one — no provider
          exposes that — so if a model is refused, the provider's own message appears on the agent.
        </p>
      )}
      {info.sources.length > 0 && (
        <details className="model-source-details">
          <summary>
            Where this list came from
            {info.sources.some((s) => s.kind === "cli-live") ? " · asked live" : ""}
          </summary>
          {info.sources.map((source, i) => (
            <p key={i} className="model-source-line">
              <span className={`model-source-tag model-source-${source.kind}`}>
                {source.kind === "cli-live" ? "live" : source.kind === "account-cache" ? "your account" : "installed build"}
              </span>
              {describeSource(source.kind, source.origin)}
              {source.version ? ` (v${source.version})` : ""} · {source.count} id{source.count === 1 ? "" : "s"} · read{" "}
              {new Date(source.readAt).toLocaleTimeString()}
            </p>
          ))}
        </details>
      )}
      {info.sourceError && (
        <p className="model-source-error">
          {info.models.length > 0 ? "Fell back after: " : "Couldn't enumerate models: "}
          {info.sourceError} You can still type any model id yourself.
        </p>
      )}
    </div>
  );
}

/** "The last turn actually ran X" - the answer to the question an alias raises and nothing in
 * the app used to answer. Only rendered when the provider itself reported a model, and only
 * when that differs from what was asked for; back-filling it would turn a real observation
 * into decoration. */
export function ResolvedModelNote({ configured, resolved }: { configured?: string; resolved?: string }) {
  if (!resolved || resolved === configured) return null;
  return (
    <div className="resolved-model">
      Last turn ran <code>{resolved}</code>
      {configured ? (
        <>
          {" "}
          for <code>{configured}</code>
        </>
      ) : null}
      <span className="resolved-model-source"> — reported by the provider</span>
    </div>
  );
}
