import { useEffect, useState } from "react";
import type { AgentConfig, AgentStatus, ChatMessage, TrustLevel } from "@solace/shared";
import { connectSocket, createAgent, fetchAgents, fetchHistory, sendChatMessage, updateAgent } from "./api";
import { AgentCard } from "./components/AgentCard";
import { AddAgentModal } from "./components/AddAgentModal";
import { ChatPanel } from "./components/ChatPanel";
import { ProvidersPanel } from "./components/ProvidersPanel";

export default function App() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [showAddAgent, setShowAddAgent] = useState(false);

  useEffect(() => {
    fetchAgents().then(setAgents);
    fetchHistory().then(setHistory);

    const disconnect = connectSocket((event) => {
      if (event.type === "hello") {
        setAgents(event.agents);
        setHistory(event.history);
        setStatuses(Object.fromEntries(event.statuses.map((s) => [s.agentId, s])));
      } else if (event.type === "chat:message") {
        setHistory((h) => [...h, event.payload]);
      } else if (event.type === "agent:status") {
        setStatuses((s) => ({ ...s, [event.payload.agentId]: event.payload }));
      }
    });
    return disconnect;
  }, []);

  const handleTrustChange = (agentId: string, trustLevel: TrustLevel) => {
    setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, trustLevel } : a)));
    void updateAgent(agentId, { trustLevel });
  };

  return (
    <div className="app">
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
            setAgents((prev) => [...prev, created]);
            setShowAddAgent(false);
          }}
        />
      )}
    </div>
  );
}
