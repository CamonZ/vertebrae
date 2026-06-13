import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { commands, SavedProject, SacrumConfigStatus } from "../bindings";
import { open } from "@tauri-apps/plugin-dialog";
import { resetProjectScopedStores } from "../stores";
import { FirstRunShell, type FirstRunPhase } from "../components";

const SETUP_PHASES: FirstRunPhase[] = [
  { kind: "Phase 01", name: "Project" },
  { kind: "Phase 02", name: "Skills & Docs" },
  { kind: "Phase 03", name: "Ignition" },
];

type SetupView = "saved" | "project" | "skills";

interface ProjectDraft {
  path: string;
  name: string;
}

const secondaryButtonClass =
  "inline-flex h-9 items-center justify-center gap-2 rounded-[var(--r-md)] border border-[var(--line-strong)] bg-transparent px-4 text-sm font-medium text-[var(--fg)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";

const primaryButtonClass =
  "inline-flex h-9 items-center justify-center gap-2 rounded-[var(--r-md)] border border-[var(--accent)] bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--bg)] transition-colors hover:border-[var(--accent-deep)] hover:bg-[var(--accent-deep)] disabled:cursor-not-allowed disabled:opacity-50";

function projectNameFromPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

export function ProjectSetupPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<SavedProject[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [setupView, setSetupView] = useState<SetupView>("saved");
  const [sacrumStatus, setSacrumStatus] = useState<SacrumConfigStatus | null>(
    null
  );
  const [isLoadingSacrumStatus, setIsLoadingSacrumStatus] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [selectedPath, setSelectedPath] = useState("");
  const [projectName, setProjectName] = useState("");
  const [sacrumUrl, setSacrumUrl] = useState("");
  const [sacrumToken, setSacrumToken] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [projectDraft, setProjectDraft] = useState<ProjectDraft | null>(null);

  // Load projects on mount
  const loadProjects = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.getProjects();
      if (result.status === "ok") {
        setProjects(result.data);
        if (result.data.length === 0) {
          setSetupView("project");
        }
      } else {
        setError(result.error.message);
      }
    } catch (e) {
      setError(`Failed to load projects: ${e}`);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (setupView !== "project" || sacrumStatus) return;

    let cancelled = false;
    async function loadSacrumStatus() {
      setIsLoadingSacrumStatus(true);
      setFormError(null);
      try {
        const result = await commands.sacrumConfigStatus();
        if (cancelled) return;
        if (result.status === "ok") {
          setSacrumStatus(result.data);
          setSacrumUrl(result.data.url);
        } else {
          setFormError(result.error.message);
        }
      } catch (e) {
        if (!cancelled) {
          setFormError(`Failed to load Sacrum settings: ${e}`);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingSacrumStatus(false);
        }
      }
    }

    loadSacrumStatus();
    return () => {
      cancelled = true;
    };
  }, [sacrumStatus, setupView]);

  // Handle selecting a project
  const handleSelectProject = async (project: SavedProject) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.setCurrentProject(project.slug);
      if (result.status === "ok") {
        resetProjectScopedStores();
        navigate("/");
      } else {
        setError(result.error.message);
      }
    } catch (e) {
      setError(`Failed to select project: ${e}`);
    } finally {
      setIsLoading(false);
    }
  };

  const showProjectForm = () => {
    setError(null);
    setFormError(null);
    setSetupView("project");
  };

  const handleChooseFolder = async () => {
    setError(null);
    setFormError(null);

    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Project Directory",
      });

      if (selected && typeof selected === "string") {
        setSelectedPath(selected);
        setProjectName((current) => current || projectNameFromPath(selected));
      }
    } catch (e) {
      setFormError(`Failed to choose project folder: ${e}`);
    }
  };

  const needsSacrumSettings =
    sacrumStatus !== null &&
    (!sacrumStatus.config_exists || !sacrumStatus.has_token);

  const handleProjectContinue = async () => {
    const trimmedName = projectName.trim();
    const trimmedUrl = sacrumUrl.trim();
    const trimmedToken = sacrumToken.trim();

    if (!selectedPath) {
      setFormError("Choose a project folder before continuing.");
      return;
    }
    if (!trimmedName) {
      setFormError("Project name is required.");
      return;
    }
    if (!sacrumStatus) {
      setFormError("Sacrum settings are required before continuing.");
      return;
    }
    if (needsSacrumSettings && !trimmedToken) {
      setFormError("Sacrum API token is required.");
      return;
    }

    setIsSavingSettings(true);
    setFormError(null);
    try {
      if (needsSacrumSettings) {
        const result = await commands.saveSacrumSettings(
          trimmedUrl || null,
          trimmedToken
        );
        if (result.status === "ok") {
          setSacrumStatus(result.data);
          setSacrumUrl(result.data.url);
        } else {
          setFormError(result.error.message);
          return;
        }
      }

      setProjectDraft({ path: selectedPath, name: trimmedName });
      setSetupView("skills");
    } catch (e) {
      setFormError(`Failed to save project settings: ${e}`);
    } finally {
      setIsSavingSettings(false);
    }
  };

  // Handle removing a project
  const handleRemoveProject = async (
    e: React.MouseEvent,
    project: SavedProject
  ) => {
    e.stopPropagation(); // Don't trigger selection

    try {
      const result = await commands.removeProject(project.slug);
      if (result.status === "ok") {
        await loadProjects();
      } else {
        setError(result.error.message);
      }
    } catch (e) {
      setError(`Failed to remove project: ${e}`);
    }
  };

  const projectCountLabel =
    projects.length === 1
      ? "1 saved project"
      : `${projects.length} saved projects`;
  const activeIndex = setupView === "skills" ? 1 : 0;
  const isProjectForm = setupView === "project";
  const title =
    setupView === "skills"
      ? "Project details ready"
      : isProjectForm
        ? projects.length === 0
          ? "Add your first project"
          : "Add a project"
        : "Choose a project";
  const lede =
    setupView === "skills"
      ? "The selected project is ready for the skills scaffold phase."
      : isProjectForm
        ? "Point Vertebrae at a folder and confirm the name it should use."
        : "Select a saved project or add a new one to prepare its local agent kit.";
  const footerLeft =
    setupView === "skills" && projectDraft
      ? `Ready: ${projectDraft.name}`
      : isLoading
        ? "Loading projects..."
        : projectCountLabel;
  const footerRight = isProjectForm ? (
    <>
      {projects.length > 0 && (
        <button
          onClick={() => setSetupView("saved")}
          className={secondaryButtonClass}
          disabled={isSavingSettings}
        >
          Back
        </button>
      )}
      <button
        onClick={handleProjectContinue}
        className={primaryButtonClass}
        disabled={isLoadingSacrumStatus || isSavingSettings}
        data-testid="project-phase-continue"
      >
        {isSavingSettings ? "Saving..." : "Continue"}
      </button>
    </>
  ) : setupView === "skills" ? (
    <button
      onClick={() => setSetupView("project")}
      className={secondaryButtonClass}
      data-testid="project-phase-back"
    >
      Edit Project
    </button>
  ) : (
    <button
      onClick={showProjectForm}
      className={secondaryButtonClass}
      data-testid="setup-add-project"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-4 w-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 4v16m8-8H4"
        />
      </svg>
      Add Project
    </button>
  );

  return (
    <FirstRunShell
      phases={SETUP_PHASES}
      activeIndex={activeIndex}
      eyebrow={
        setupView === "skills"
          ? "Phase 02 · Skills & Docs"
          : "Phase 01 · Project"
      }
      title={title}
      lede={lede}
      footerLeft={footerLeft}
      footerRight={footerRight}
    >
      {/* Error message */}
      {error && (
        <div className="mb-4 rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-center text-red-400">
          {error}
        </div>
      )}

      {formError && (
        <div
          className="mb-4 rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-center text-red-400"
          data-testid="project-phase-error"
        >
          {formError}
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="py-12 text-center text-fg-soft">
          Loading projects...
        </div>
      )}

      {/* Projects list */}
      {!isLoading && setupView === "saved" && (
        <div className="space-y-2" data-testid="setup-project-list">
          {projects.length === 0 ? (
            <div className="py-12 text-center text-fg-soft">
              No projects added yet. Add a project to get started.
            </div>
          ) : (
            projects.map((project) => (
              <div
                key={project.slug}
                onClick={() => handleSelectProject(project)}
                className="flex cursor-pointer items-center justify-between rounded-lg border border-border p-4 transition-colors hover:border-accent hover:bg-bg-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-fg">{project.slug}</span>
                  </div>
                  <div className="mt-1 truncate text-sm text-fg-mute">
                    {project.path || project.project_id}
                  </div>
                </div>
                <button
                  onClick={(e) => handleRemoveProject(e, project)}
                  className="ml-4 rounded p-2 text-fg-mute transition-colors hover:bg-red-500/10 hover:text-red-400"
                  title="Remove from list"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                    />
                  </svg>
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {!isLoading && setupView === "project" && (
        <div className="space-y-4" data-testid="project-phase-form">
          <div className="fr-field">
            <label>Project folder</label>
            <div className="fr-folder">
              <span className="fic" aria-hidden>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                >
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </span>
              <span className={`fpath${selectedPath ? "" : " ph"}`}>
                {selectedPath || "No folder selected"}
              </span>
              <button
                onClick={handleChooseFolder}
                className={secondaryButtonClass}
                data-testid="project-folder-choose"
              >
                {selectedPath ? "Change..." : "Choose folder..."}
              </button>
            </div>
          </div>

          <div className="fr-field">
            <label htmlFor="project-name">Project name</label>
            <input
              id="project-name"
              className="fr-input"
              placeholder="e.g. cervical"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
            />
          </div>

          {isLoadingSacrumStatus && (
            <div className="fr-callout">
              <span>Loading Sacrum settings...</span>
            </div>
          )}

          {needsSacrumSettings && (
            <>
              <div className="fr-callout">
                <span>
                  Sacrum settings are missing or incomplete. Save them here
                  before initializing this project.
                </span>
              </div>
              <div className="fr-field">
                <label htmlFor="sacrum-url">Sacrum URL</label>
                <input
                  id="sacrum-url"
                  className="fr-input"
                  value={sacrumUrl}
                  onChange={(e) => setSacrumUrl(e.target.value)}
                />
              </div>
              <div className="fr-field">
                <label htmlFor="sacrum-token">Sacrum API token</label>
                <input
                  id="sacrum-token"
                  className="fr-input"
                  type="password"
                  value={sacrumToken}
                  onChange={(e) => setSacrumToken(e.target.value)}
                />
              </div>
            </>
          )}
        </div>
      )}

      {!isLoading && setupView === "skills" && projectDraft && (
        <div className="fr-callout" data-testid="project-phase-ready">
          <span>
            {projectDraft.name} at {projectDraft.path} is ready for the skills
            scaffold phase.
          </span>
        </div>
      )}
    </FirstRunShell>
  );
}
