/**
 * Every kind of thing this app can connect to, as data.
 *
 * The point of this file is that adding a connector is an entry in this list plus a check
 * function on the server - not another redesign of the Connections panel. The chooser, the
 * section subheads in the list, and the "how is this verified" line under each one all
 * render from here, so a new kind cannot appear in one place and be missing from another.
 *
 * `verification` is deliberately part of the shape rather than UI copy: this project's rule
 * is that nothing shows a working state it has not actually proven, so every kind has to
 * declare, in one sentence, what its check really does. A kind that cannot be checked says
 * so (see "vault") instead of borrowing someone else's green dot.
 */

export type ConnectorKindId = "cli" | "github" | "local-server" | "hosted-api" | "ssh" | "vault";

export interface ConnectorKind {
  id: ConnectorKindId;
  /** Row title in the chooser, and the subhead its entries sit under in the list. */
  title: string;
  /** One line: what this kind actually is, in the user's terms. */
  blurb: string;
  /**
   * Exactly what this kind's check does when the user presses it. Shown verbatim next to the
   * check, so "verified" never means more than it should.
   */
  verification: string;
  /**
   * False for the kinds that have no honest cheap check at all. The UI must not render a
   * pass/fail state for these - a stored password is just stored; whether the far end still
   * accepts it is not knowable without trying to sign in, which this app does not do behind
   * the user's back.
   */
  checkable: boolean;
}

export const CONNECTOR_KINDS: ConnectorKind[] = [
  {
    // First on purpose. A CLI signed in against a subscription is the whole reason this app
    // exists, and it was previously the least prominent row in the panel.
    id: "cli",
    title: "Coding agent CLI",
    blurb: "Claude Code, Codex, Gemini or Qwen, signed in on this machine against your own subscription.",
    // No backticks in any string on this record: these are rendered as plain text in the Add
    // connection modal, so markdown punctuation shows up literally on screen.
    verification: "Runs the CLI's own --version and reports what it printed.",
    checkable: true,
  },
  {
    id: "github",
    title: "GitHub",
    blurb: "Lets agents clone, push, open PRs and read issues as you, through the gh CLI.",
    verification: "Runs gh auth status and shows what it said, word for word.",
    checkable: true,
  },
  {
    id: "local-server",
    title: "Local model server",
    blurb: "Ollama, LM Studio, Jan, llama.cpp and friends - a model running on this machine, billed to nobody.",
    verification: "Asks the server for its own model list and reports what came back.",
    checkable: true,
  },
  {
    id: "hosted-api",
    title: "Hosted API endpoint",
    blurb: "Any OpenAI-compatible endpoint you have a key for.",
    verification: "Runs a real GET /models against the saved key and reports what came back.",
    checkable: true,
  },
  {
    id: "ssh",
    title: "Deploy target (SSH)",
    blurb: "A machine an agent can be asked to deploy to. Solace stores the address and a reference to your key.",
    verification: "Checks the key file it points at is still there and readable. It does not sign in.",
    checkable: true,
  },
  {
    id: "vault",
    title: "Login or secret",
    blurb: "A service password, token, licence or recovery code an agent can ask for by name.",
    verification: "Nothing to check - a stored secret is stored. Only the service it belongs to can say if it still works.",
    checkable: false,
  },
];

export function connectorKind(id: ConnectorKindId): ConnectorKind {
  const found = CONNECTOR_KINDS.find((k) => k.id === id);
  // Not a silent fallback: an id that isn't in the list means the list and the code that
  // renders it have drifted, which is exactly the bug this file exists to make impossible.
  if (!found) throw new Error(`unknown connector kind: ${id}`);
  return found;
}
