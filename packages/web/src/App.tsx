import { useEffect, useMemo, useState } from "react";
import type { AgentConfig, AgentStatus, ChatMessage, TrustLevel } from "@solace/shared";
import { connectSocket, createAgent, fetchAgents, fetchHistory, sendChatMessage, updateAgent } from "./api";
import { AgentCard } from "./components/AgentCard";
import { AddAgentModal } from "./components/AddAgentModal";
import { ChatPanel } from "./components/ChatPanel";
import { ProvidersPanel } from "./components/ProvidersPanel";

export default function App() {
  // Keyed by id (not an array) so any event that's delivered more than once - e.g. two
  // WebSocket connections briefly overlapping under React StrictMode's dev-mode double
  // effect invoke - is naturally idempotent instead of appending a visible duplicate.
  const [agentsById, setAgentsById] = useState<Record<string, AgentConfig>>({});
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  const [historyById, setHistoryById] = useState<Record<string, ChatMessage>>({});
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [connected, setConnected] = useState(true);

  const agents = useMemo(() => Object.values(agentsById), [agentsById]);
  const history = useMemo(
    () => Object.values(historyById).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [historyById],
  );

  useEffect(() => {
    fetchAgents().then((list) => setAgentsById(Object.fromEntries(list.map((a) => [a.id, a]))));
    fetchHistory().then((list) => setHistoryById(Object.fromEntries(list.map((m) => [m.id, m]))));

    const disconnect = connectSocket(
      (event) => {
        if (event.type === "hello") {
          setAgentsById(Object.fromEntries(event.agents.map((a) => [a.id, a])));
          setHistoryById(Object.fromEntries(event.history.map((m) => [m.id, m])));
          setStatuses(Object.fromEntries(event.statuses.map((s) => [s.agentId, s])));
        } else if (event.type === "chat:message") {
          setHistoryById((h) => ({ ...h, [event.payload.id]: event.payload }));
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
            onTrustChange={(level) => handleTrustChange(agent.id, level)}
          />
        ))}
        <button className="add-agent-btn" onClick={() => setShowAddAgent(true)}>
          + Add agent
        </button>
        <div className="sidebar-section-label">Providers</div>
        <ProvidersPanel />
      </aside>
      <ChatPanel history={history} agents={agents} onSend={(text) => void sendChatMessage(text)} />
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
    </div>
  );
}
