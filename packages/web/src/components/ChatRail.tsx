import { useEffect, useRef, useState } from "react";
import type { ChatMeta, ProjectMeta } from "@solace/shared";

/**
 * The project selector and the chat list - the two things the app was missing entirely. There
 * was exactly one chat, addressed by a hardcoded channel name, and no way to start another.
 *
 * Chrome is kept to the minimum the interaction needs: the row actions only appear on hover or
 * keyboard focus, and renaming happens in the row itself rather than in a modal, because a
 * dialog for a one-word edit is more ceremony than the edit.
 */
export function ChatRail({
  chats,
  projects,
  activeProjectId,
  activeChatId,
  onSelectProject,
  onAddProject,
  onUnlinkProject,
  onSelectChat,
  onNewChat,
  onRenameChat,
  onDeleteChat,
}: {
  chats: ChatMeta[];
  projects: ProjectMeta[];
  activeProjectId: string | null;
  activeChatId: string | null;
  onSelectProject: (id: string | null) => void;
  onAddProject: (name: string) => Promise<void>;
  onUnlinkProject: (project: ProjectMeta) => void;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onRenameChat: (id: string, title: string) => void;
  onDeleteChat: (chat: ChatMeta) => void;
}) {
  const [addingProject, setAddingProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectError, setProjectError] = useState<string | null>(null);
  const [savingProject, setSavingProject] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);

  const activeProject = projects.find((p) => p.id === activeProjectId);

  // focus() before select(): the click that starts a rename lands on the pencil button, so
  // without moving focus explicitly the user's first keystroke goes to that button and is lost.
  useEffect(() => {
    if (!renamingId) return;
    renameRef.current?.focus();
    renameRef.current?.select();
  }, [renamingId]);

  const submitProject = async () => {
    const name = projectName.trim();
    if (!name) {
      setProjectError("Give the project a name");
      return;
    }
    setSavingProject(true);
    setProjectError(null);
    try {
      await onAddProject(name);
      setProjectName("");
      setAddingProject(false);
    } catch (err) {
      setProjectError((err as Error).message);
    } finally {
      setSavingProject(false);
    }
  };

  const commitRename = (chat: ChatMeta) => {
    const next = draftTitle.trim();
    if (next && next !== chat.title) onRenameChat(chat.id, next);
    setRenamingId(null);
  };

  return (
    <>
      <section className="sidebar-group">
        <div className="sidebar-section-label">Project</div>

        <div className="project-select-row">
          <select
            className="select project-select"
            aria-label="Project"
            value={activeProjectId ?? ""}
            onChange={(e) => onSelectProject(e.target.value || null)}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className="icon-btn"
            title="Add a project"
            aria-label="Add a project"
            onClick={() => {
              setAddingProject((v) => !v);
              setProjectError(null);
            }}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M8 3.5v9M3.5 8h9" />
            </svg>
          </button>
        </div>

        {addingProject && (
          <div className="project-add">
            <input
              className="project-add-input"
              autoFocus
              placeholder="Project name"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitProject();
                if (e.key === "Escape") setAddingProject(false);
              }}
            />
            <button className="project-add-go" disabled={savingProject} onClick={() => void submitProject()}>
              {savingProject ? "Adding…" : "Add"}
            </button>
            {/* Says what actually happens on disk, because "add a project" could just as easily
                mean "make a folder" or "point at one" - it is both, and the user should know. */}
            <div className="project-add-hint">
              Creates the folder in your workspace if it isn't there yet, or links it if it is.
            </div>
            {projectError && <div className="project-add-error">{projectError}</div>}
          </div>
        )}

        {activeProject && (
          <div className="project-meta">
            <span className="project-path" title={activeProject.path}>
              {activeProject.path}
            </span>
            <button className="project-unlink" onClick={() => onUnlinkProject(activeProject)}>
              Unlink
            </button>
          </div>
        )}
      </section>

      <section className="sidebar-group">
        <div className="sidebar-section-label">
          Chats
          <span className="count">{chats.length}</span>
        </div>

        {chats.length === 0 ? (
          <div className="sidebar-empty">
            {activeProject ? `No chats in ${activeProject.name} yet.` : "No chats yet."}
          </div>
        ) : (
          chats.map((chat) =>
            renamingId === chat.id ? (
              <div key={chat.id} className="chat-row is-renaming">
                <input
                  ref={renameRef}
                  className="chat-rename-input"
                  defaultValue={chat.title}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onBlur={() => commitRename(chat)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(chat);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                />
              </div>
            ) : (
              <div key={chat.id} className={`chat-row ${chat.id === activeChatId ? "is-active" : ""}`}>
                <button
                  className="chat-row-open"
                  onClick={() => onSelectChat(chat.id)}
                  aria-current={chat.id === activeChatId ? "page" : undefined}
                >
                  <span className="chat-row-title">{chat.title}</span>
                </button>
                <span className="chat-row-actions">
                  <button
                    className="icon-btn"
                    title="Rename"
                    aria-label={`Rename ${chat.title}`}
                    onClick={() => {
                      setDraftTitle(chat.title);
                      setRenamingId(chat.id);
                    }}
                  >
                    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M11.2 2.8 13.2 4.8 5.5 12.5 2.8 13.2 3.5 10.5z" />
                    </svg>
                  </button>
                  <button
                    className="icon-btn"
                    title="Archive this chat"
                    aria-label={`Archive ${chat.title}`}
                    onClick={() => onDeleteChat(chat)}
                  >
                    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M2.5 5h11M4 5V3.5h8V5M5.5 5v8.5h5V5" />
                    </svg>
                  </button>
                </span>
              </div>
            ),
          )
        )}

        <button className="add-agent-btn" onClick={onNewChat}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M8 3.5v9M3.5 8h9" />
          </svg>
          New chat
        </button>
      </section>
    </>
  );
}
