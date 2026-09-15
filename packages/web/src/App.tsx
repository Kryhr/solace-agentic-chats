import { useEffect, useMemo, useState } from "react";
import type {
  AgentConfig,
  AgentStatus,
  ChatMessage,
  PendingApproval,
  ProviderModelInfo,
  ProviderPermissionInfo,
  ProviderRateLimit,
  TrustLevel,
} from "@solace/shared";
import {
  clearAgentHistory,
  connectSocket,
  createAgent,
  fetchAgentDirectHistory,
  fetchAgents,
  fetchArchives,
  fetchHistory,
  fetchPermissionModes,
  fetchProviderModels,
  removeAgent,
  resolveApproval,
  retryAgent,
  sendAgentDirectMessage,
  sendChatMessage,
  stopAgent,
  updateAgent,
  type ChatArchive,
} from "./api";
import { AgentCard } from "./components/AgentCard";
import { AddAgentModal } from "./components/AddAgentModal";
import { AgentHubPage } from "./components/AgentHubPage";
import { ApprovalPrompt } from "./components/ApprovalPrompt";
import { ArchivesPage } from "./components/ArchivesPage";
import { ChatPanel } from "./components/ChatPanel";
import { GithubPanel } from "./components/GithubPanel";
import { ProvidersPanel, SavedConnections } from "./components/ProvidersPanel";
import { SkillsPage } from "./components/SkillsPage";

type View = { type: "chat" } | { type: "hub"; agentId: string } | { type: "archives" } | { type: "skills" };

function parseHash(hash: string): View {
  const agentMatch = hash.match(/^#\/agent\/(.+)$/);
  if (agentMatch) return { type: "hub", agentId: agentMatch[1] };
  if (hash === "#/archives") return { type: "archives" };
  if (hash === "#/skills") return { type: "skills" };
  return { type: "chat" };
}

export default function App() {
  // Keyed by id (not an array) so any event that's delivered more than once - e.g. two
  // WebSocket connections briefly overlapping under React StrictMode's dev-mode double
  // effect invoke - is naturally idempotent instead of appending a visible duplicate.
  const [agentsById, setAgentsById] = useState<Record<string, AgentConfig>>({});
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  /** Keyed by provider, not by agent: several agents can share one CLI and therefore one real
   * account and one real limit. */
  const [rateLimits, setRateLimits] = useState<Record<string, ProviderRateLimit>>({});
  const [historyById, setHistoryById] = useState<Record<string, ChatMessage>>({});
  const [directById, setDirectById] = useState<Record<string, Record<string, ChatMessage>>>({});
  const [modelCatalog, setModelCatalog] = useState<ProviderModelInfo[]>([]);
  const [permissionCatalog, setPermissionCatalog] = useState<ProviderPermissionInfo[]>([]);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [connected, setConnected] = useState(true);
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, PendingApproval>>({});
  const [archives, setArchives] = useState<ChatArchive[]>([]);
  const [view, setView] = useState<View>(() => parseHash(location.hash));

  const agents = useMemo(() => Object.values(agentsById), [agentsById]);
  const history = useMemo(
    () => Object.values(historyById).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [historyById],
  );

  useEffect(() => {
    const onHashChange = () => {
      const next = parseHash(location.hash);
      setView(next);
      if (next.type === "archives") fetchArchives().then(setArchives);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const goToHub = (agentId: string) => {
    location.hash = `#/agent/${agentId}`;
    fetchAgentDirectHistory(agentId).then((list) => {
      setDirectById((d) => ({ ...d, [agentId]: { ...Object.fromEntries(list.map((m) => [m.id, m])), ...d[agentId] } }));
    });
  };
  const goToChat = () => {
    location.hash = "";
  };
  const goToArchives = () => {
    location.hash = "#/archives";
    fetchArchives().then(setArchives);
  };
  const goToSkills = () => {
    location.hash = "#/skills";
  };

  useEffect(() => {
    fetchAgents().then((list) => setAgentsById(Object.fromEntries(list.map((a) => [a.id, a]))));
    fetchHistory().then((list) => setHistoryById(Object.fromEntries(list.map((m) => [m.id, m]))));
    fetchProviderModels().then(setModelCatalog);
    fetchPermissionModes().then(setPermissionCatalog);

    const disconnect = connectSocket(
      (event) => {
        if (event.type === "hello") {
          setAgentsById(Object.fromEntries(event.agents.map((a) => [a.id, a])));
          setHistoryById(Object.fromEntries(event.history.map((m) => [m.id, m])));
          setStatuses(Object.fromEntries(event.statuses.map((s) => [s.agentId, s])));
          // Replace, don't merge: the approval registry is in-memory only, so a server
          // restart (e.g. a dev-mode reload) wipes every pending approval it knew about. A
          // stale approval card left over in this tab's own state from before that restart
          // would otherwise sit there forever with Allow/Deny buttons pointing at an id the
          // server has never heard of - a fresh "hello" is this tab's one chance to notice
          // the server's approval state has moved on and drop anything it no longer knows.
          setPendingApprovals(Object.fromEntries(event.approvals.map((a) => [a.id, a])));
          setRateLimits(Object.fromEntries((event.rateLimits ?? []).map((r) => [r.provider, r])));
        } else if (event.type === "chat:message") {
          if (event.payload.channel === "group") {
            setHistoryById((h) => ({ ...h, [event.payload.id]: event.payload }));
          } else {
            const agentId = event.payload.channel.agentId;
            setDirectById((d) => ({ ...d, [agentId]: { ...d[agentId], [event.payload.id]: event.payload } }));
          }
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
          if (event.payload.channel === "group") {
            setHistoryById({});
          } else {
            const agentId = event.payload.channel.agentId;
            setDirectById((d) => ({ ...d, [agentId]: {} }));
          }
          fetchArchives().then(setArchives);
        }
      },
      (isConnected) => setConnected(isConnected),
    );
    return disconnect;
  }, []);

  const handleTrustChange = (agentId: string, trustLevel: TrustLevel) => {
    setAgentsById((prev) => (prev[agentId] ? { ...prev, [agentId]: { ...prev[agentId], trustLevel } } : prev));
    void updateAgent(agentId, { trustLevel });
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
          <h1>solace</h1>
          <span className="brand-sub">agentic chats</span>
        </div>

        <div className="sidebar-scroll">
          <section className="sidebar-group">
            <div className="sidebar-section-label">
              Agents
              <span className="count">{agents.length}</span>
            </div>
            {agents.length === 0 ? (
              <div className="sidebar-empty">No agents yet. Add one to start a session.</div>
            ) : (
              agents.map((agent) => (
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

          {/* Providers and GitHub are the same kind of thing - a connection this machine
              either has or doesn't - so they share one list instead of two headed sections. */}
          <section className="sidebar-group">
            <div className="sidebar-section-label">
              Connections
            </div>
            <div className="connection-list">
              <ProvidersPanel />
              <GithubPanel />
              {/* Saved API keys sit last: the rows above are "is this machine signed in",
                  these are keys the user pasted and can add/remove here. */}
              <SavedConnections />
            </div>
          </section>
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
        </div>
      </aside>

      {view.type === "archives" ? (
        <ArchivesPage archives={archives} agentsById={agentsById} onBack={goToChat} />
      ) : view.type === "skills" ? (
        <SkillsPage onBack={goToChat} />
      ) : hubAgent ? (
        <AgentHubPage
          agent={hubAgent}
          status={statuses[hubAgent.id]}
          modelInfo={modelCatalog.find((m) => m.provider === hubAgent.provider)}
          permissionInfo={permissionCatalog.find((p) => p.provider === hubAgent.provider)}
          directHistory={hubDirectHistory}
          onBack={goToChat}
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
          history={history}
          agents={agents}
          statuses={statuses}
          modelCatalog={modelCatalog}
          rateLimits={Object.values(rateLimits)}
          connected={connected}
          onSend={(text) => sendChatMessage(text)}
        />
      )}

      {showAddAgent && (
        <AddAgentModal
          modelCatalog={modelCatalog}
          permissionCatalog={permissionCatalog}
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
