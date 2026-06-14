import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  commands,
  events,
  InitializeProjectResult,
  ProjectInitProgressEvent,
  SavedProject,
  SacrumConfigStatus,
} from "../bindings";
import { open } from "@tauri-apps/plugin-dialog";
import { resetProjectScopedStores } from "../stores";
import { FirstRunShell, type FirstRunPhase } from "../components";

const SETUP_PHASES: FirstRunPhase[] = [
  { kind: "Phase 01", name: "Project" },
  { kind: "Phase 02", name: "Skills & Docs" },
  { kind: "Phase 03", name: "Ignition" },
];

type SetupView = "saved" | "project" | "skills" | "ignition";
type FileState = "idle" | "queued" | "writing" | "written";

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
  const writeTimers = useRef<number[]>([]);
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
  const [sacrumStatusRetryKey, setSacrumStatusRetryKey] = useState(0);
  const [projectDraft, setProjectDraft] = useState<ProjectDraft | null>(null);
  const [embeddedSkills, setEmbeddedSkills] = useState<string[]>([]);
  const [isLoadingSkills, setIsLoadingSkills] = useState(true);
  const [isInitializing, setIsInitializing] = useState(false);
  const [fileStates, setFileStates] = useState<Record<string, FileState>>({});
  const [initializeResult, setInitializeResult] =
    useState<InitializeProjectResult | null>(null);

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
    let cancelled = false;
    async function loadSkills() {
      setIsLoadingSkills(true);
      try {
        const result = await commands.listEmbeddedSkills();
        if (cancelled) return;
        if (result.status === "ok") {
          setEmbeddedSkills(result.data);
        } else {
          setError(result.error.message);
        }
      } catch (e) {
        if (!cancelled) {
          setError(`Failed to load embedded skills: ${e}`);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingSkills(false);
        }
      }
    }

    loadSkills();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      writeTimers.current.forEach((timer) => window.clearTimeout(timer));
      writeTimers.current = [];
    };
  }, []);

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
  }, [sacrumStatus, sacrumStatusRetryKey, setupView]);

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
  const skillFilePaths = useMemo(
    () => embeddedSkills.map((skill) => `${skill}/SKILL.md`),
    [embeddedSkills]
  );

  const markFileWriting = useCallback((relativePath: string) => {
    setFileStates((current) => ({
      ...current,
      [relativePath]: "writing",
    }));
    const timer = window.setTimeout(() => {
      setFileStates((current) => ({
        ...current,
        [relativePath]: "written",
      }));
    }, 250);
    writeTimers.current.push(timer);
  }, []);

  const markAllFilesWritten = useCallback(() => {
    setFileStates(
      Object.fromEntries(skillFilePaths.map((path) => [path, "written"]))
    );
  }, [skillFilePaths]);

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

  const handleInitializeProject = async () => {
    if (!projectDraft || isInitializing) return;

    setFormError(null);
    setIsInitializing(true);

    let unlisten: (() => void) | null = null;
    try {
      const slugResult = await commands.previewProjectSlug(projectDraft.name);
      if (slugResult.status === "error") {
        setFormError(slugResult.error.message);
        return;
      }

      const expectedSlug = slugResult.data;
      setInitializeResult(null);
      setFileStates(
        Object.fromEntries(skillFilePaths.map((path) => [path, "queued"]))
      );

      unlisten = await events.projectInitProgressEvent.listen((event) => {
        const payload = event.payload as ProjectInitProgressEvent;
        if (payload.project_slug !== expectedSlug) return;
        if (
          payload.kind === "SkillFileInstalled" &&
          payload.relative_path
        ) {
          markFileWriting(payload.relative_path);
        }
        if (payload.kind === "Completed") {
          markAllFilesWritten();
        }
      });

      const result = await commands.initializeProject(
        projectDraft.path,
        projectDraft.name
      );
      if (result.status === "error") {
        setFormError(result.error.message);
        return;
      }

      setInitializeResult(result.data);
      markAllFilesWritten();
      const selectResult = await commands.setCurrentProject(result.data.slug);
      if (selectResult.status === "error") {
        setFormError(selectResult.error.message);
        return;
      }
      resetProjectScopedStores();
      setSetupView("ignition");
    } catch (e) {
      setFormError(`Failed to initialize project: ${e}`);
    } finally {
      unlisten?.();
      setIsInitializing(false);
    }
  };

  const handleRetrySacrumStatus = () => {
    setFormError(null);
    setSacrumStatusRetryKey((current) => current + 1);
  };

  const enterInitializedProject = () => {
    navigate("/");
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
  const activeIndex =
    setupView === "ignition" ? 2 : setupView === "skills" ? 1 : 0;
  const isProjectForm = setupView === "project";
  const writtenFileCount = skillFilePaths.filter(
    (path) => fileStates[path] === "written"
  ).length;
  const title =
    setupView === "ignition"
      ? "Project ready"
      : setupView === "skills"
        ? `Equip ${projectDraft?.name ?? "the project"}`
        : isProjectForm
          ? projects.length === 0
            ? "Add your first project"
            : "Add a project"
          : "Choose a project";
  const lede =
    setupView === "ignition"
      ? "Project setup is complete. Vertebrae selected the project and installed the local skill files."
      : setupView === "skills"
        ? "All embedded skills will be installed into this project as a read-only starter kit."
        : isProjectForm
          ? "Point Vertebrae at a folder and confirm the name it should use."
          : "Select a saved project or add a new one to prepare its local agent kit.";
  const footerLeft =
    setupView === "ignition" && initializeResult
      ? `${initializeResult.skills_copied} skill files written`
      : setupView === "skills"
        ? isInitializing
          ? `${writtenFileCount} / ${skillFilePaths.length} skill files written`
          : `Adds ${skillFilePaths.length} skill files`
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
    <>
      <button
        onClick={() => setSetupView("project")}
        className={secondaryButtonClass}
        data-testid="project-phase-back"
        disabled={isInitializing}
      >
        Edit Project
      </button>
      <button
        onClick={handleInitializeProject}
        className={primaryButtonClass}
        data-testid="skills-install"
        disabled={isLoadingSkills || isInitializing || !projectDraft}
      >
        {isInitializing ? "Writing..." : "Install skills"}
      </button>
    </>
  ) : setupView === "ignition" ? (
    <button
      onClick={enterInitializedProject}
      className={primaryButtonClass}
      data-testid="ignition-enter"
    >
      Enter {initializeResult?.project_name ?? "project"}
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
        setupView === "ignition"
          ? "Initialized"
          : setupView === "skills"
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
          className="mb-4 flex flex-wrap items-center justify-center gap-3 rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-center text-red-400"
          data-testid="project-phase-error"
        >
          <span>{formError}</span>
          {setupView === "project" && !sacrumStatus && (
            <button
              onClick={handleRetrySacrumStatus}
              className={secondaryButtonClass}
              disabled={isLoadingSacrumStatus}
              data-testid="sacrum-status-retry"
            >
              Retry
            </button>
          )}
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
        <div className="space-y-5" data-testid="skills-phase">
          {isLoadingSkills ? (
            <div className="fr-callout">
              <span>Loading embedded skills...</span>
            </div>
          ) : (
            <>
              <div className="fr-sec-lbl">
                <span className="t">Skills to install</span>
                <span className="n">{embeddedSkills.length} skills</span>
              </div>
              <div className="fr-skills">
                {embeddedSkills.map((skill) => (
                  <div
                    className="fr-skill on"
                    key={skill}
                    data-testid={`skill-${skill}`}
                  >
                    <div className="si">
                      <div className="sn">
                        <span className="glyph" aria-hidden>
                          +
                        </span>
                        {skill}
                      </div>
                      <div className="sd">Embedded Vertebrae skill</div>
                    </div>
                    <span className="fr-lock">included</span>
                  </div>
                ))}
              </div>

              <div className="fr-sec-lbl">
                <span className="t">Files it writes</span>
                <span className="n">{skillFilePaths.length} files</span>
              </div>
              <div className="fr-tree" data-testid="skills-file-tree">
                <div className="fr-tr">
                  <span className="nm dir">.claude/skills/</span>
                  <span className="ds">embedded agent skills</span>
                </div>
                {skillFilePaths.map((path) => {
                  const state =
                    fileStates[path] ?? (isInitializing ? "queued" : "idle");
                  return (
                    <div
                      className={`fr-tr ind${state === "queued" ? " queued" : ""}`}
                      key={path}
                    >
                      <span className="nm">{path}</span>
                      <span className="ds">skill</span>
                      {state !== "idle" && (
                        <span
                          className={`fstate ${
                            state === "written"
                              ? "done"
                              : state === "writing"
                                ? "work"
                                : "queued"
                          }`}
                          data-testid={`file-state-${path}`}
                        >
                          {state}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="fr-callout">
                <span>
                  All embedded skills are installed together; this flow does not
                  support deselecting individual skills.
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {!isLoading && setupView === "ignition" && initializeResult && (
        <div className="fr-ignite" data-testid="ignition-screen">
          <div className="fr-flame" aria-hidden />
          <div className="fr-summary">
            <div className="fr-sum">
              <div className="v">{initializeResult.skills_copied}</div>
              <div className="l">skill files</div>
            </div>
            <div className="fr-sum">
              <div className="v">{initializeResult.project_name}</div>
              <div className="l">project</div>
            </div>
            <div className="fr-sum">
              <div className="v">
                {initializeResult.project_created ? "new" : "linked"}
              </div>
              <div className="l">Sacrum</div>
            </div>
          </div>
          <div className="fr-callout">
            <span>Installed into {initializeResult.skills_target}</span>
          </div>
        </div>
      )}
    </FirstRunShell>
  );
}
