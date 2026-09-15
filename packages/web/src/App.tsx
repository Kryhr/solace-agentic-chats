import { useEffect, useMemo, useState } from "react";
import type { AgentConfig, AgentStatus, ChatMessage, ProviderModelInfo, TrustLevel } from "@solace/shared";
import {
  connectSocket,
  createAgent,
  fetchAgentDirectHistory,
  fetchAgents,
  fetchHistory,
  fetchProviderModels,
  sendAgentDirectMessage,
  sendChatMessage,
  updateAgent,
} from "./api";
import { AgentCard } from "./components/AgentCard";
import { AddAgentModal } from "./components/AddAgentModal";
import { AgentHubModal } from "./components/AgentHubModal";
import { ChatPanel } from "./components/ChatPanel";
import { ProvidersPanel } from "./components/ProvidersPanel";

export default function App() {
  // Keyed by id (not an array) so any event that's delivered more than once - e.g. two
  // WebSocket connections briefly overlapping under React StrictMode's dev-mode double
  // effect invoke - is naturally idempotent instead of appending a visible duplicate.
  const [agentsById, setAgentsById] = useState<Record<string, AgentConfig>>({});
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  const [historyById, setHistoryById] = useState<Record<string, ChatMessage>>({});
  const [directById, setDirectById] = useState<Record<string, Record<string, ChatMessage>>>({});
  const [modelCatalog, setModelCatalog] = useState<ProviderModelInfo[]>([]);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [hubAgentId, setHubAgentId] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);

  const agents = useMemo(() => Object.values(agentsById), [agentsById]);
  const history = useMemo(
    () => Object.values(historyById).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [historyById],
  );

  useEffect(() => {
    fetchAgents().then((list) => setAgentsById(Object.fromEntries(list.map((a) => [a.id, a]))));
    fetchHistory().then((list) => setHistoryById(Object.fromEntries(list.map((m) => [m.id, m]))));
    fetchProviderModels().then(setModelCatalog);

    const disconnect = connectSocket(
      (event) => {
        if (event.type === "hello") {
          setAgentsById(Object.fromEntries(event.agents.map((a) => [a.id, a])));
          setHistoryById(Object.fromEntries(event.history.map((m) => [m.id, m])));
          setStatuses(Object.fromEntries(event.statuses.map((s) => [s.agentId, s])));
        } else if (event.type === "chat:message") {
          if (event.payload.channel === "group") {
            setHistoryById((h) => ({ ...h, [event.payload.id]: event.payload }));
          } else {
            const agentId = event.payload.channel.agentId;
            setDirectById((d) => ({ ...d, [agentId]: { ...d[agentId], [event.payload.id]: event.payload } }));
          }
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

  const openHub = (agentId: string) => {
    setHubAgentId(agentId);
    fetchAgentDirectHistory(agentId).then((list) => {
      setDirectById((d) => ({ ...d, [agentId]: { ...Object.fromEntries(list.map((m) => [m.id, m])), ...d[agentId] } }));
    });
  };

  const hubAgent = hubAgentId ? agentsById[hubAgentId] : null;
  const hubDirectHistory = useMemo(
    () => (hubAgentId && directById[hubAgentId] ? Object.values(directById[hubAgentId]).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : []),
    [hubAgentId, directById],
  );

  return (
    <div className="app">
      {!connected && <div className="reconnect-banner">Reconnecting to server…</div>}
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>solace-agentic-chats</h1>
          <span className="count">{agents.length}</span>
        </div>
        <div className="sidebar-section-label">Agent hubs</div>
        {agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            status={statuses[agent.id]}
            modelInfo={modelCatalog.find((m) => m.provider === agent.provider)}
            onTrustChange={(level) => handleTrustChange(agent.id, level)}
            onOpen={() => openHub(agent.id)}
          />
        ))}
        <button className="add-agent-btn" onClick={() => setShowAddAgent(true)}>
          + Add agent
        </button>
        <div className="sidebar-section-label">Providers</div>
        <ProvidersPanel />
      </aside>
      <ChatPanel history={history} agents={agents} modelCatalog={modelCatalog} onSend={(text) => void sendChatMessage(text)} />
      {showAddAgent && (
        <AddAgentModal
          onClose={() => setShowAddAgent(false)}
          onCreate={async (config) => {
            const created = await createAgent(config);
            setAgentsById((a) => ({ ...a, [created.id]: created }));
            setShowAddAgent(false);
          }}
        />
      )}
      {hubAgent && (
        <AgentHubModal
          agent={hubAgent}
          status={statuses[hubAgent.id]}
          modelInfo={modelCatalog.find((m) => m.provider === hubAgent.provider)}
          directHistory={hubDirectHistory}
          onClose={() => setHubAgentId(null)}
          onSave={(patch) => {
            setAgentsById((a) => (a[hubAgent.id] ? { ...a, [hubAgent.id]: { ...a[hubAgent.id], ...patch } } : a));
            void updateAgent(hubAgent.id, patch);
          }}
          onSendDirect={(text) => void sendAgentDirectMessage(hubAgent.id, text)}
        />
      )}
    </div>
  );
}
