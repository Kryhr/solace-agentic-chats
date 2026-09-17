/**
 * The one place the server's own port is decided.
 *
 * It used to be decided in eleven: `index.ts` bound `process.env.PORT ?? 4310`, and each of the
 * ten adapters independently computed the same expression to tell the MCP bridge where to call
 * back. That works only for as long as every copy agrees.
 *
 * It stopped agreeing. A second instance on a different port left the adapters on the old
 * one - So every agent's `post_to_group` called the
 * STABLE instance, carrying a turn token the DEV instance had minted, and was correctly refused
 * with "no matching in-flight turn". Agents spent a whole session unable to talk to each other
 * mid-turn, and one of them resent its message because it could tell the first had not arrived.
 *
 * A default duplicated across files is a default waiting to diverge, so there is now exactly one
 * of it. `PORT` still overrides, and reading it once at import matches how the listener binds:
 * a turn cannot be answered by a port the server is not on.
 */
export const SERVER_PORT = Number(process.env.PORT ?? 4310);
