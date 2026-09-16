import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_APP_SETTINGS,
  isChatChannel,
  type AgentConfig,
  type AgentStatus,
  type AppSettings,
  type ChatMessage,
  type ChatMeta,
  type PendingApproval,
  type ProjectMeta,
  type ProviderModelInfo,
  type ProviderPermissionInfo,
  type ProviderRateLimit,
  type TrustLevel,
} from "@solace/shared";
import {
  clearAgentHistory,
  connectSocket,
  createAgent,
  createChat,
  deleteChat,
  fetchAgentDirectHistory,
  fetchAgents,
  fetchArchives,
  fetchChatHistory,
  fetchChats,
  fetchPermissionModes,
  fetchProviderModels,
  linkProject,
  removeAgent,
  resolveApproval,
  retryAgent,
  sendAgentDirectMessage,
  sendChatMessage,
  stopAgent,
  unlinkProject,
  updateAgent,
  updateChat,
  type ChatArchive,
} from "./api";
import { AgentCard } from "./components/AgentCard";
import { AddAgentModal } from "./components/AddAgentModal";
import { AgentHubPage } from "./components/AgentHubPage";
import { ApprovalPrompt } from "./components/ApprovalPrompt";
import { ArchivesPage } from "./components/ArchivesPage";
import { ChatPanel } from "./components/ChatPanel";
import { ChatRail } from "./components/ChatRail";
import { ConnectionsPanel } from "./components/ConnectionsPanel";
import { McpPanel } from "./components/McpPanel";
import { SettingsPage } from "./components/SettingsPage";
import { SkillsPage } from "./components/SkillsPage";
import { agentsInScope, chatsInScope } from "./lib/projectScope";

type View =
  /** chatId null means "whichever chat is first" - the hash carries no id on a cold start. */
  | { type: "chat"; chatId: string | null }
  | { type: "hub"; agentId: string }
  | { type: "archives" }
  | { type: "skills" }
  | { type: "settings" };

function parseHash(hash: string): View {
  const agentMatch = hash.match(/^#\/agent\/(.+)$/);
  if (agentMatch) return { type: "hub", agentId: agentMatch[1] };
  const chatMatch = hash.match(/^#\/chat\/(.+)$/);
  if (chatMatch) return { type: "chat", chatId: chatMatch[1] };
  if (hash === "#/archives") return { type: "archives" };
  if (hash === "#/skills") return { type: "skills" };
  if (hash === "#/settings") return { type: "settings" };
  return { type: "chat", chatId: null };
}

/** Which project the sidebar is scoped to, remembered across reloads. Kept in localStorage
 * rather than the hash: it is a view preference, not an address - a link someone pastes to a
 * chat should open that chat, not silently re-scope their sidebar too. */
const PROJECT_SCOPE_KEY = "solace.activeProjectId";

export default function App() {
  // Keyed by id (not an array) so any event that's delivered more than once - e.g. two
  // WebSocket connections briefly overlapping under React StrictMode's dev-mode double
  // effect invoke - is naturally idempotent instead of appending a visible duplicate.
  const [agentsById, setAgentsById] = useState<Record<string, AgentConfig>>({});
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  /** Keyed by provider, not by agent: several agents can share one CLI and therefore one real
   * account and one real limit. */
  const [rateLimits, setRateLimits] = useState<Record<string, ProviderRateLimit>>({});
  /** Chat transcripts, keyed chatId -> messageId. Nested rather than flat so a chat can be
   * emptied or dropped without walking every message the tab has ever seen. */
  const [chatHistory, setChatHistory] = useState<Record<string, Record<string, ChatMessage>>>({});
  const [chats, setChats] = useState<ChatMeta[]>([]);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(
    () => localStorage.getItem(PROJECT_SCOPE_KEY) || null,
  );
  const [directById, setDirectById] = useState<Record<string, Record<string, ChatMessage>>>({});
  const [modelCatalog, setModelCatalog] = useState<ProviderModelInfo[]>([]);
  const [permissionCatalog, setPermissionCatalog] = useState<ProviderPermissionInfo[]>([]);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [connected, setConnected] = useState(true);
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, PendingApproval>>({});
  const [archives, setArchives] = useState<ChatArchive[]>([]);
  /** App settings live on the server. null means "not fetched yet", which is deliberately not
   * the same as the defaults - a page that rendered defaults while loading would briefly show
   * every toggle off regardless of what the server actually holds. */
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [view, setView] = useState<View>(() => parseHash(location.hash));

  const agents = useMemo(() => Object.values(agentsById), [agentsById]);
  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId),
    [projects, activeProjectId],
  );
  const scopedChats = useMemo(() => chatsInScope(chats, activeProject), [chats, activeProject]);
  // settings can be null until the first fetch lands; default to following, which is the
  // server's own default, so the sidebar never briefly shows an empty project roster.
  const agentsFollow = settings?.agentsFollowProjects ?? true;
  const scopedAgents = useMemo(
    () => agentsInScope(agents, activeProject, agentsFollow),
    [agents, activeProject, agentsFollow],
  );

  /** The chat actually on screen. A hash pointing at a chat that has since been archived falls
   * back to the first in scope rather than rendering a blank page with no way out. */
  const activeChatId = useMemo(() => {
    if (view.type !== "chat") return null;
    if (view.chatId && chats.some((c) => c.id === view.chatId)) return view.chatId;
    return scopedChats[0]?.id ?? chats[0]?.id ?? null;
  }, [view, chats, scopedChats]);

  const activeChat = useMemo(() => chats.find((c) => c.id === activeChatId), [chats, activeChatId]);

  /** The last chat actually on screen, so leaving for an agent hub (or Saved chats, or Skills)
   * and coming back returns you where you were. goToChat() with no id used to clear the hash
   * entirely, and the fallback then picked the FIRST chat in scope - so with more than one chat
   * open, "back" reliably landed you in the wrong conversation. */
  const lastChatIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeChatId) lastChatIdRef.current = activeChatId;
  }, [activeChatId]);
  /** The project the OPEN chat is filed under, which is not necessarily the one the sidebar is
   * scoped to: "All projects" still shows a project's chat, and that chat still only reaches
   * its own project's agents. */
  const activeChatProject = useMemo(
    () => projects.find((p) => p.id === activeChat?.projectId),
    [projects, activeChat],
  );
  const activeChatAgents = useMemo(
    () => (activeChat ? agentsInScope(agents, activeChatProject, agentsFollow) : []),
    [agents, activeChat, activeChatProject, agentsFollow],
  );

  const history = useMemo(() => {
    const bucket = activeChatId ? chatHistory[activeChatId] : undefined;
    return bucket ? Object.values(bucket).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [];
  }, [chatHistory, activeChatId]);

  const loadChatHistory = (chatId: string) => {
    fetchChatHistory(chatId).then((list) => {
      // Server rows first, this tab's live rows second: a message that arrived over the socket
      // while the fetch was in flight must not be overwritten by the older snapshot.
      setChatHistory((h) => ({ ...h, [chatId]: { ...Object.fromEntries(list.map((m) => [m.id, m])), ...h[chatId] } }));
    });
  };

  // Loading a hub's history hung off goToHub, i.e. off the CLICK - so arriving at
  // #/agent/:id any other way (a refresh while on a hub, a pasted link, a back/forward step)
  // rendered a populated conversation as the "no messages yet" empty state. Keying it to the
  // VIEW instead means every route into a hub loads it, however you got there.
  const loadHubHistory = (agentId: string) => {
    fetchAgentDirectHistory(agentId).then((list) => {
      setDirectById((d) => ({ ...d, [agentId]: { ...Object.fromEntries(list.map((m) => [m.id, m])), ...d[agentId] } }));
    });
  };

  useEffect(() => {
    // Only routes here. What each view needs to LOAD is keyed off the view below, not off
    // this handler - hanging a fetch off navigation meant arriving any other way (a refresh,
    // a pasted link, back/forward) rendered a populated conversation as an empty state.
    const onHashChange = () => setView(parseHash(location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (view.type === "hub") loadHubHistory(view.agentId);
    if (view.type === "archives") fetchArchives().then(setArchives);
  }, [view.type, view.type === "hub" ? view.agentId : ""]);

  // Whichever chat resolves to "current" - including the fall-back on a cold start, where the
  // hash carries no id at all - needs its transcript fetched exactly once.
  const loadedChats = useRef(new Set<string>());
  /** The socket callback is registered once and never re-created, so it cannot close over
   * activeChatId - it reads the current value through this instead. */
  const activeChatIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeChatIdRef.current = activeChatId;
    if (!activeChatId || loadedChats.current.has(activeChatId)) return;
    loadedChats.current.add(activeChatId);
    loadChatHistory(activeChatId);
  }, [activeChatId]);

  const goToHub = (agentId: string) => {
    location.hash = `#/agent/${agentId}`;
  };
  const goToChat = (chatId?: string) => {
    const target = chatId ?? lastChatIdRef.current;
    location.hash = target ? `#/chat/${target}` : "";
  };
  const goToArchives = () => {
    location.hash = "#/archives";
    fetchArchives().then(setArchives);
  };
  const goToSkills = () => {
    location.hash = "#/skills";
  };
  const goToSettings = () => {
    location.hash = "#/settings";
  };

  useEffect(() => {
    fetchAgents().then((list) => setAgentsById(Object.fromEntries(list.map((a) => [a.id, a]))));
    fetchChats().then(({ chats: list, projects: linked }) => {
      setChats(list);
      setProjects(linked);
    });
    fetchProviderModels().then(setModelCatalog);
    fetchPermissionModes().then(setPermissionCatalog);

    const disconnect = connectSocket(
      (event) => {
        if (event.type === "hello") {
          setAgentsById(Object.fromEntries(event.agents.map((a) => [a.id, a])));
          setChats(event.chats ?? []);
          setProjects(event.projects ?? []);
          // A reconnect means this tab may have missed messages while it was away, so refetch
          // the transcript it is actually showing. Cached rows are kept meanwhile, so the panel
          // never blanks - the fetch merges under whatever the socket has already delivered.
          loadedChats.current.clear();
          if (activeChatIdRef.current) loadChatHistory(activeChatIdRef.current);
          setStatuses(Object.fromEntries(event.statuses.map((s) => [s.agentId, s])));
          // Replace, don't merge: the approval registry is in-memory only, so a server
          // restart (e.g. a dev-mode reload) wipes every pending approval it knew about. A
          // stale approval card left over in this tab's own state from before that restart
          // would otherwise sit there forever with Allow/Deny buttons pointing at an id the
          // server has never heard of - a fresh "hello" is this tab's one chance to notice
          // the server's approval state has moved on and drop anything it no longer knows.
          setPendingApprovals(Object.fromEntries(event.approvals.map((a) => [a.id, a])));
          setRateLimits(Object.fromEntries((event.rateLimits ?? []).map((r) => [r.provider, r])));
          if (event.settings) setSettings(event.settings);
        } else if (event.type === "chat:message" || event.type === "chat:message:updated") {
          // Both branches are the same write. History is keyed by id, so replacing an existing
          // entry is exactly what an update means, and a promotion (progress -> answer) can't
          // reorder the transcript or re-trigger the entrance animation: useEntranceTracker
          // memoises its decision per id, so a message already on screen stays as it is.
          const channel = event.payload.channel;
          if (isChatChannel(channel)) {
            setChatHistory((h) => ({
              ...h,
              [channel.chatId]: { ...h[channel.chatId], [event.payload.id]: event.payload },
            }));
          } else {
            const agentId = channel.agentId;
            setDirectById((d) => ({ ...d, [agentId]: { ...d[agentId], [event.payload.id]: event.payload } }));
          }
        } else if (event.type === "chats:updated") {
          setChats(event.payload.chats);
          setProjects(event.payload.projects);
        } else if (event.type === "settings:updated") {
          setSettings(event.payload);
        } else if (event.type === "usage:rate-limit") {
          setRateLimits((r) => ({ ...r, [event.payload.provider]: event.payload }));
        } else if (event.type === "agent:status") {
          setStatuses((s) => ({ ...s, [event.payload.agentId]: event.payload }));
        } else if (event.type === "agent:added" || event.type === "agent:updated") {
          setAgentsById((a) => ({ ...a, [event.payload.id]: event.payload }));
        } else if (event.type === "agent:removed") {
          setAgentsById((a) => {
            const next = { ...a };
            delete next[event.payload.agentId];
            return next;
          });
        } else if (event.type === "approval:requested") {
          setPendingApprovals((a) => ({ ...a, [event.payload.id]: event.payload }));
        } else if (event.type === "approval:resolved") {
          setPendingApprovals((a) => {
            const next = { ...a };
            delete next[event.payload.id];
            return next;
          });
        } else if (event.type === "chat:cleared") {
          const channel = event.payload.channel;
          if (isChatChannel(channel)) {
            setChatHistory((h) => ({ ...h, [channel.chatId]: {} }));
          } else {
            const agentId = channel.agentId;
            setDirectById((d) => ({ ...d, [agentId]: {} }));
          }
          fetchArchives().then(setArchives);
        }
      },
      (isConnected) => setConnected(isConnected),
    );
    return disconnect;
  }, []);

  // The model and permission catalogs are fetched once on mount, so a tab opened before a
  // provider existed knows nothing about it - and an agent using that provider then rendered
  // an EMPTY model list and an EMPTY trust dropdown, which reads as a broken black box rather
  // than as stale data. Refetch when an agent turns up whose provider we have no catalog for.
  useEffect(() => {
    const known = new Set(permissionCatalog.map((p) => p.provider));
    const missing = agents.some((a) => a.provider !== "custom" && a.provider !== "local" && !known.has(a.provider));
    if (!missing) return;
    fetchProviderModels().then(setModelCatalog);
    fetchPermissionModes().then(setPermissionCatalog);
  }, [agents, permissionCatalog]);

  const handleTrustChange = (agentId: string, trustLevel: TrustLevel) => {
    setAgentsById((prev) => (prev[agentId] ? { ...prev, [agentId]: { ...prev[agentId], trustLevel } } : prev));
    void updateAgent(agentId, { trustLevel });
  };

  const handleSelectProject = (id: string | null) => {
    setActiveProjectId(id);
    if (id) localStorage.setItem(PROJECT_SCOPE_KEY, id);
    else localStorage.removeItem(PROJECT_SCOPE_KEY);
  };

  const handleNewChat = async () => {
    // A new chat inherits whatever project the sidebar is scoped to, so the one the user just
    // made does not immediately vanish out of the list they made it in.
    const chat = await createChat(undefined, activeProject?.id);
    // Added by id, not appended: the server's own chats:updated broadcast is already on its way
    // over this tab's socket, and whichever of the two lands second must not produce a second
    // row for the same chat.
    setChats((c) => (c.some((x) => x.id === chat.id) ? c : [...c, chat]));
    goToChat(chat.id);
  };

  const handleDeleteChat = async (chat: ChatMeta) => {
    // Named "Archive" here and everywhere else this is offered, because that is what it does:
    // the transcript moves to Saved chats, only the room goes away.
    if (!confirm(`Archive "${chat.title}"? Its messages move to Saved chats - nothing is deleted.`)) return;
    await deleteChat(chat.id);
    setChats((list) => list.filter((c) => c.id !== chat.id));
    if (activeChatId === chat.id) goToChat();
    fetchArchives().then(setArchives);
  };

  const handleUnlinkProject = async (project: ProjectMeta) => {
    if (
      !confirm(
        `Unlink "${project.name}"? Its chats become unfiled and its agents keep working exactly as they are. ` +
          `Nothing in ${project.path} is deleted or moved.`,
      )
    ) {
      return;
    }
    await unlinkProject(project.id);
    handleSelectProject(null);
  };

  const hubAgent = view.type === "hub" ? agentsById[view.agentId] : null;
  const hubDirectHistory = useMemo(
    () =>
      hubAgent && directById[hubAgent.id]
        ? Object.values(directById[hubAgent.id]).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        : [],
    [hubAgent, directById],
  );

  return (
    <div className="app">
      {!connected && <div className="reconnect-banner">Reconnecting to server…</div>}
      {Object.keys(pendingApprovals).length > 0 && (
        <div className="approval-stack">
          {Object.values(pendingApprovals).map((approval) => (
            <ApprovalPrompt
              key={approval.id}
              approval={approval}
              agent={agentsById[approval.agentId]}
              onResolve={(approved) => void resolveApproval(approval.id, approved)}
            />
          ))}
        </div>
      )}
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>Solace</h1>
          <span className="brand-sub">agentic chats</span>
        </div>

        <div className="sidebar-scroll">
          <ChatRail
            chats={scopedChats}
            projects={projects}
            activeProjectId={activeProjectId}
            activeChatId={view.type === "chat" ? activeChatId : null}
            onSelectProject={handleSelectProject}
            onAddProject={async (name) => {
              const project = await linkProject(name);
              setProjects((p) => (p.some((x) => x.id === project.id) ? p : [...p, project]));
              handleSelectProject(project.id);
            }}
            onUnlinkProject={(project) => void handleUnlinkProject(project)}
            onSelectChat={(id) => goToChat(id)}
            onNewChat={() => void handleNewChat()}
            onRenameChat={(id, title) => {
              setChats((list) => list.map((c) => (c.id === id ? { ...c, title } : c)));
              void updateChat(id, { title });
            }}
            onDeleteChat={(chat) => void handleDeleteChat(chat)}
          />

          <section className="sidebar-group">
            <div className="sidebar-section-label">
              Agents
              <span className="count">{scopedAgents.length}</span>
            </div>
            {scopedAgents.length === 0 ? (
              <div className="sidebar-empty">
                {activeProject
                  ? agentsFollow
                    ? `No agents yet. Add one and it will be in ${activeProject.name} and every other project.`
                    : `No agents working in ${activeProject.name}. Agents are pinned to their own folder right now, so add one pointed at this folder - or turn on "Agents follow you between projects" in Settings.`
                  : "No agents yet. Add one to start a session."}
              </div>
            ) : (
              scopedAgents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  status={statuses[agent.id]}
                  modelInfo={modelCatalog.find((m) => m.provider === agent.provider)}
                  permissionInfo={permissionCatalog.find((p) => p.provider === agent.provider)}
                  onTrustChange={(level) => handleTrustChange(agent.id, level)}
                  onOpen={() => goToHub(agent.id)}
                />
              ))
            )}
            <button className="add-agent-btn" onClick={() => setShowAddAgent(true)}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <path d="M8 3.5v9M3.5 8h9" />
              </svg>
              Add agent
            </button>
          </section>

          {/* Every kind of connection - CLI agents, GitHub, local servers, hosted endpoints,
              deploy targets, vault entries - is one list behind one "Add connection", so no
              single kind reads as what Connections is for. See ConnectionsPanel.tsx. */}
          <ConnectionsPanel />

        </div>

        <div className="sidebar-footer">
          <button
            className={`nav-row ${view.type === "archives" ? "is-active" : ""}`}
            onClick={goToArchives}
            aria-current={view.type === "archives" ? "page" : undefined}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 4.5h12v9H2zM2 2.5h12v2H2zM6.5 7.5h3" />
            </svg>
            Saved chats
          </button>
          <button
            className={`nav-row ${view.type === "skills" ? "is-active" : ""}`}
            onClick={goToSkills}
            aria-current={view.type === "skills" ? "page" : undefined}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 1.75 9.9 5.6l4.35.6-3.15 3.05.74 4.25L8 11.5l-3.84 2 .74-4.25L1.75 6.2l4.35-.6z" />
            </svg>
            Skills
          </button>
          <button
            className={`nav-row ${view.type === "settings" ? "is-active" : ""}`}
            onClick={goToSettings}
            aria-current={view.type === "settings" ? "page" : undefined}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="8" cy="8" r="2.25" />
              <path d="M8 1.75v1.6M8 12.65v1.6M1.75 8h1.6M12.65 8h1.6M3.58 3.58l1.13 1.13M11.29 11.29l1.13 1.13M12.42 3.58l-1.13 1.13M4.71 11.29l-1.13 1.13" />
            </svg>
            Settings
          </button>
        </div>
      </aside>

      {view.type === "archives" ? (
        <ArchivesPage archives={archives} agentsById={agentsById} onBack={() => goToChat()} />
      ) : view.type === "skills" ? (
        <SkillsPage onBack={() => goToChat()} />
      ) : view.type === "settings" ? (
        <SettingsPage
          settings={settings}
          onSettingsChange={setSettings}
          agents={agents}
          projects={projects}
          onProjectsChange={setProjects}
          onBack={() => goToChat()}
        />
      ) : hubAgent ? (
        <AgentHubPage
          agent={hubAgent}
          status={statuses[hubAgent.id]}
          modelInfo={modelCatalog.find((m) => m.provider === hubAgent.provider)}
          permissionInfo={permissionCatalog.find((p) => p.provider === hubAgent.provider)}
          directHistory={hubDirectHistory}
          onBack={() => goToChat()}
          backLabel={chats.find((c) => c.id === lastChatIdRef.current)?.title ?? "Chats"}
          onSave={(patch) => {
            setAgentsById((a) => (a[hubAgent.id] ? { ...a, [hubAgent.id]: { ...a[hubAgent.id], ...patch } } : a));
            void updateAgent(hubAgent.id, patch);
          }}
          onSendDirect={(text) => sendAgentDirectMessage(hubAgent.id, text)}
          onClearHistory={() => void clearAgentHistory(hubAgent.id)}
          onRemoveAgent={() => void removeAgent(hubAgent.id)}
          onStop={() => void stopAgent(hubAgent.id)}
          onRetry={() => void retryAgent(hubAgent.id)}
        />
      ) : (
        <ChatPanel
          chat={activeChat}
          project={activeChatProject}
          history={history}
          // The roster shown, the @mention autocomplete and the "n agents" count are all the
          // agents this chat can actually reach - the same set the server routes to. Showing
          // the whole roster here would offer @mentions that silently go nowhere.
          agents={activeChatAgents}
          statuses={statuses}
          modelCatalog={modelCatalog}
          rateLimits={Object.values(rateLimits)}
          connected={connected}
          onNewChat={() => void handleNewChat()}
          onSend={(text) => (activeChatId ? sendChatMessage(activeChatId, text) : Promise.resolve())}
        />
      )}

      {showAddAgent && (
        <AddAgentModal
          modelCatalog={modelCatalog}
          permissionCatalog={permissionCatalog}
          // Until the settings have loaded, the documented default - the same value the server
          // would report - rather than a second hard-coded guess that could drift from it.
          defaultTrustLevel={settings?.defaultTrustLevel ?? DEFAULT_APP_SETTINGS.defaultTrustLevel}
          defaultProjectPath={activeProject?.path}
          onClose={() => setShowAddAgent(false)}
          onCreate={async (config) => {
            const created = await createAgent(config);
            setAgentsById((a) => ({ ...a, [created.id]: created }));
            setShowAddAgent(false);
          }}
        />
      )}
    </div>
  );
}
