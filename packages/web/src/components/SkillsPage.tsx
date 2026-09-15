import { useEffect, useMemo, useState } from "react";
import { fetchSkills, importSkillsRepo, installSkill, type ProjectInfo, type SkillInfo } from "../api";

/**
 * A "skill" here is a Claude Code skill directory (SKILL.md + optional references/), and
 * installing one is literally copying that directory into `<project>/.claude/skills/<name>/`.
 * The installed flags come from the server reading disk, so this page always reflects what a
 * CLI running in that project would actually pick up.
 */
export function SkillsPage({ onBack }: { onBack: () => void }) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [query, setQuery] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    fetchSkills()
      .then((data) => {
        setSkills(data.skills);
        setProjects(data.projects);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }, [skills, query]);

  const handleInstall = async (skill: SkillInfo, project: ProjectInfo) => {
    const key = `${skill.sourcePath}::${project.path}`;
    setBusyKey(key);
    setError(null);
    try {
      await installSkill(skill.sourcePath, project.path);
      // Mark installed locally rather than refetching the whole list - the server's answer
      // is "it's on disk now" either way (an already-installed skill isn't an error).
      setSkills((prev) =>
        prev.map((s) =>
          s.sourcePath === skill.sourcePath && !s.installedIn.includes(project.path)
            ? { ...s, installedIn: [...s.installedIn, project.path] }
            : s,
        ),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const handleImport = async () => {
    if (!repoUrl.trim() || importing) return;
    setImporting(true);
    setError(null);
    try {
      const imported = await importSkillsRepo(repoUrl.trim());
      setSkills((prev) => {
        const bySource = new Map(prev.map((s) => [s.sourcePath, s]));
        for (const s of imported) bySource.set(s.sourcePath, s);
        return [...bySource.values()].sort((a, b) => a.name.localeCompare(b.name));
      });
      setRepoUrl("");
      if (imported.length === 0) setError("That repo cloned fine, but contains no SKILL.md directories.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="hub-page">
      <div className="hub-page-header">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Group chat
        </button>
        <div className="hub-page-identity">
          <h2>Skills</h2>
        </div>
      </div>

      <div className="hub-page-chat">
        <div className="skills-toolbar">
          <input
            className="skills-search"
            type="search"
            placeholder="Search skills by name or description…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search skills"
          />
          <div className="skills-import-row">
            <input
              className="skills-repo-input"
              type="text"
              placeholder="https://github.com/user/skills-repo"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleImport();
              }}
              aria-label="Skill repo URL"
            />
            <button className="skills-import-btn" onClick={() => void handleImport()} disabled={importing || !repoUrl.trim()}>
              {importing ? "Importing…" : "Import from repo"}
            </button>
          </div>
          {error && <div className="skills-error">{error}</div>}
        </div>

        {loading ? (
          <div className="chat-empty">
            <div className="chat-empty-title">Loading skills…</div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-title">{skills.length === 0 ? "No skills found" : "No matches"}</div>
            <div className="chat-empty-body">
              {skills.length === 0
                ? "Skills are read from ~/.claude/skills. Import a repo above to add more."
                : "Nothing matches that search."}
            </div>
          </div>
        ) : (
          <div className="skills-list">
            {filtered.map((skill) => (
              <div key={skill.sourcePath} className="skill-entry">
                <div className="skill-entry-name">{skill.name}</div>
                {skill.description && <div className="skill-entry-desc">{skill.description}</div>}
                <div className="skill-entry-projects">
                  {projects.length === 0 ? (
                    <span className="skill-entry-hint">No projects yet - create one to install skills into.</span>
                  ) : (
                    projects.map((project) =>
                      skill.installedIn.includes(project.path) ? (
                        <span key={project.path} className="skill-installed-tag">
                          Installed in {project.name}
                        </span>
                      ) : (
                        <button
                          key={project.path}
                          className="skill-install-btn"
                          disabled={busyKey === `${skill.sourcePath}::${project.path}`}
                          onClick={() => void handleInstall(skill, project)}
                          title={`Copy into ${project.path}\\.claude\\skills\\${skill.name}`}
                        >
                          {busyKey === `${skill.sourcePath}::${project.path}` ? "Installing…" : `Install to ${project.name}`}
                        </button>
                      ),
                    )
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
