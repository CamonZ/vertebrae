import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  commands,
  events,
  InitializeProjectResult,
  LocalBackendProgressEvent,
  SavedProject,
  SacrumConfigStatus,
} from "../bindings";
import { open } from "@tauri-apps/plugin-dialog";
import { resetProjectScopedStores } from "../stores";
import { FirstRunShell, type FirstRunPhase } from "../components";

const SAVED_PROJECT_PHASES: FirstRunPhase[] = [
  { kind: "Phase 01", name: "Project" },
  { kind: "Phase 02", name: "Ready" },
];

const FIRST_RUN_PHASES: FirstRunPhase[] = [
  { kind: "Phase 01", name: "Backend" },
  { kind: "Phase 02", name: "Project" },
  { kind: "Phase 03", name: "Ready" },
];

type SetupView = "saved" | "backend" | "project" | "ignition";
type BackendChoice = "remote" | "local";

const secondaryButtonClass =
  "inline-flex h-9 items-center justify-center gap-2 rounded-[var(--r-md)] border border-[var(--line-strong)] bg-transparent px-4 text-sm font-medium text-[var(--fg)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";

const primaryButtonClass =
  "inline-flex h-9 items-center justify-center gap-2 rounded-[var(--r-md)] border border-[var(--accent)] bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--bg)] transition-colors hover:border-[var(--accent-deep)] hover:bg-[var(--accent-deep)] disabled:cursor-not-allowed disabled:opacity-50";

function projectNameFromPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function isLikelyTokenError(message: string): boolean {
  return /\b(token|auth|unauthori[sz]ed|forbidden|401|403)\b/i.test(message);
}

export function ProjectSetupPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<SavedProject[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [setupView, setSetupView] = useState<SetupView>("saved");
  const [backendChoice, setBackendChoice] = useState<BackendChoice | null>(
    null
  );
  const [sacrumStatus, setSacrumStatus] = useState<SacrumConfigStatus | null>(
    null
  );
  const [isLoadingSacrumStatus, setIsLoadingSacrumStatus] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [selectedPath, setSelectedPath] = useState("");
  const [projectName, setProjectName] = useState("");
  const [sacrumUrl, setSacrumUrl] = useState("");
  const [sacrumToken, setSacrumToken] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [accountUsername, setAccountUsername] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [localProgress, setLocalProgress] =
    useState<LocalBackendProgressEvent | null>(null);
  const [localAdoptionRequired, setLocalAdoptionRequired] = useState(false);
  const [isProvisioningLocal, setIsProvisioningLocal] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [sacrumStatusRetryKey, setSacrumStatusRetryKey] = useState(0);
  const [isInitializing, setIsInitializing] = useState(false);
  const [initializeResult, setInitializeResult] =
    useState<InitializeProjectResult | null>(null);

  const loadProjects = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.getProjects();
      if (result.status === "ok") {
        setProjects(result.data);
        if (result.data.length === 0) {
          setBackendChoice(null);
          setSetupView("backend");
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
    if (setupView !== "project" || backendChoice !== "remote" || sacrumStatus)
      return;

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
  }, [backendChoice, sacrumStatus, sacrumStatusRetryKey, setupView]);

  useEffect(() => {
    if (setupView !== "project" || backendChoice !== "local") return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void events.localBackendProgressEvent
      .listen((event) => {
        if (!cancelled) setLocalProgress(event.payload);
      })
      .then((cleanup) => {
        if (cancelled) cleanup();
        else unlisten = cleanup;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [backendChoice, setupView]);

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
    if (projects.length === 0) {
      setSetupView("backend");
      return;
    }
    setBackendChoice("remote");
    setSetupView("project");
  };

  const handleBackendContinue = () => {
    if (!backendChoice) {
      setFormError("Choose how Vertebrae should connect to Sacrum.");
      return;
    }
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
    (!sacrumStatus.config_exists ||
      !sacrumStatus.has_token ||
      sacrumUrl.trim() !== sacrumStatus.url);

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
    if (backendChoice === "remote" && !trimmedUrl) {
      setFormError("Sacrum URL is required.");
      return;
    }

    if (backendChoice === "local") {
      const trimmedEmail = accountEmail.trim();
      const trimmedUsername = accountUsername.trim();
      if (!trimmedEmail || !trimmedUsername || !accountPassword) {
        setFormError("Email, username, and password are required.");
        return;
      }

      setFormError(null);
      setLocalProgress(null);
      setIsProvisioningLocal(true);
      try {
        const result = await commands.setupLocalBackend(
          trimmedEmail,
          trimmedUsername,
          accountPassword,
          localAdoptionRequired
        );
        if (result.status === "error") {
          setFormError(result.error.message);
          return;
        }
        if (result.data.status === "adoption_required") {
          setLocalAdoptionRequired(true);
          setFormError(
            result.data.adoption_message ??
              "A compatible vertebrae-dev backend was detected. Confirm adoption to continue."
          );
          return;
        }

        setLocalAdoptionRequired(false);
        setAccountPassword("");
        setIsInitializing(true);
        setInitializeResult(null);
        const initResult = await commands.initializeProject(
          selectedPath,
          trimmedName
        );
        if (initResult.status === "error") {
          setFormError(initResult.error.message);
          return;
        }
        setInitializeResult(initResult.data);
        const selectResult = await commands.setCurrentProject(
          initResult.data.slug
        );
        if (selectResult.status === "error") {
          setFormError(selectResult.error.message);
          return;
        }
        resetProjectScopedStores();
        setSetupView("ignition");
      } catch (e) {
        setFormError(`Failed to set up local backend: ${e}`);
      } finally {
        setAccountPassword("");
        setIsProvisioningLocal(false);
        setIsInitializing(false);
      }
      return;
    }

    if (!sacrumStatus) {
      setFormError("Sacrum settings are required before continuing.");
      return;
    }
    if (!sacrumStatus.has_token && !trimmedToken) {
      setFormError("Sacrum API token is required.");
      return;
    }

    setIsSavingSettings(true);
    setIsInitializing(true);
    setFormError(null);
    try {
      if (needsSacrumSettings) {
        const result = await commands.saveSacrumSettings(
          trimmedUrl,
          trimmedToken
        );
        if (result.status === "ok") {
          setSacrumStatus(result.data);
          setSacrumUrl(result.data.url);
          setSacrumToken("");
        } else {
          setFormError(result.error.message);
          return;
        }
      }

      setInitializeResult(null);
      const result = await commands.initializeProject(
        selectedPath,
        trimmedName
      );
      if (result.status === "error") {
        if (isLikelyTokenError(result.error.message)) {
          setSacrumStatus((current) =>
            current
              ? {
                  ...current,
                  has_token: false,
                }
              : current
          );
          setSacrumToken("");
          setFormError(
            "Sacrum rejected the API token. Enter a valid token and try again."
          );
        } else {
          setFormError(result.error.message);
        }
        return;
      }

      setInitializeResult(result.data);
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
      setIsSavingSettings(false);
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
  const isFirstRun = projects.length === 0;
  const phases = isFirstRun ? FIRST_RUN_PHASES : SAVED_PROJECT_PHASES;
  const activeIndex = isFirstRun
    ? setupView === "backend"
      ? 0
      : setupView === "ignition"
        ? 2
        : 1
    : setupView === "ignition"
      ? 1
      : 0;
  const isProjectForm = setupView === "project";
  const title =
    setupView === "ignition"
      ? "Project ready"
      : setupView === "backend"
        ? "Choose your backend"
        : isProjectForm
          ? projects.length === 0
            ? "Add your first project"
            : "Add a project"
          : "Choose a project";
  const lede =
    setupView === "ignition"
      ? "Project setup is complete. Vertebrae registered and selected the project."
      : setupView === "backend"
        ? "Choose an existing Sacrum backend or run one locally with Docker."
        : isProjectForm
          ? "Point Vertebrae at a folder and confirm the name it should use."
          : "Select a saved project or add a new one.";
  const footerLeft =
    setupView === "ignition" && initializeResult
      ? "Project registered and selected"
      : isLoading
        ? "Loading projects..."
        : projectCountLabel;
  const footerRight =
    setupView === "backend" ? (
      <button
        onClick={handleBackendContinue}
        className={primaryButtonClass}
        disabled={!backendChoice}
        data-testid="backend-choice-continue"
      >
        Continue
      </button>
    ) : isProjectForm ? (
      <>
        {projects.length > 0 ? (
          <button
            onClick={() => setSetupView("saved")}
            className={secondaryButtonClass}
            disabled={isSavingSettings || isProvisioningLocal}
          >
            Back
          </button>
        ) : (
          <button
            onClick={() => setSetupView("backend")}
            className={secondaryButtonClass}
            disabled={isSavingSettings || isProvisioningLocal}
            data-testid="project-back-backend"
          >
            Back
          </button>
        )}
        <button
          onClick={handleProjectContinue}
          className={primaryButtonClass}
          disabled={
            isLoadingSacrumStatus ||
            isSavingSettings ||
            isInitializing ||
            isProvisioningLocal
          }
          data-testid="project-phase-continue"
        >
          {isProvisioningLocal
            ? "Setting up..."
            : isSavingSettings || isInitializing
              ? "Creating..."
              : localAdoptionRequired
                ? "Adopt backend"
                : "Create project"}
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
      phases={phases}
      activeIndex={activeIndex}
      eyebrow={
        setupView === "ignition"
          ? "Initialized"
          : setupView === "backend"
            ? "Phase 01 · Backend"
            : isFirstRun
              ? "Phase 02 · Project"
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
          {setupView === "project" &&
            backendChoice === "remote" &&
            !sacrumStatus && (
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

      {setupView === "project" &&
        backendChoice === "local" &&
        localProgress && (
          <div
            className="mb-4 rounded-lg border border-border bg-bg-2 p-3"
            data-testid="local-backend-progress"
          >
            <div className="text-sm font-medium text-fg">
              {localProgress.message}
            </div>
            <div className="mt-2 grid grid-cols-4 gap-1 text-[0.65rem] uppercase tracking-[0.12em] text-fg-mute">
              {(["pulling", "migrating", "health", "seeding"] as const).map(
                (stage) => (
                  <span
                    key={stage}
                    className={
                      stage === localProgress.stage ? "text-accent" : ""
                    }
                  >
                    {stage}
                  </span>
                )
              )}
            </div>
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
          <div className="fr-callout" data-testid="selected-backend">
            {backendChoice === "local"
              ? "Docker-hosted local backend"
              : "Existing Sacrum backend"}
          </div>

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

          {backendChoice === "remote" && isLoadingSacrumStatus && (
            <div className="fr-callout">
              <span>Loading Sacrum settings...</span>
            </div>
          )}

          {backendChoice === "remote" && sacrumStatus && (
            <>
              <div className="fr-field">
                <label htmlFor="sacrum-url">Sacrum URL</label>
                <input
                  id="sacrum-url"
                  className="fr-input"
                  type="url"
                  value={sacrumUrl}
                  onChange={(e) => {
                    setSacrumUrl(e.target.value);
                    setFormError(null);
                  }}
                />
              </div>
              {(!sacrumStatus.has_token || needsSacrumSettings) && (
                <div className="fr-field">
                  <label htmlFor="sacrum-token">Sacrum API token</label>
                  <input
                    id="sacrum-token"
                    className="fr-input"
                    type="password"
                    placeholder={
                      sacrumStatus.has_token
                        ? "Leave blank to keep current token"
                        : undefined
                    }
                    value={sacrumToken}
                    onChange={(e) => {
                      setSacrumToken(e.target.value);
                      setFormError(null);
                    }}
                  />
                </div>
              )}
            </>
          )}

          {backendChoice === "local" && (
            <>
              <div className="space-y-4">
                <div className="fr-field">
                  <label htmlFor="local-account-email">Sacrum email</label>
                  <input
                    id="local-account-email"
                    className="fr-input"
                    type="email"
                    value={accountEmail}
                    onChange={(e) => {
                      setAccountEmail(e.target.value);
                      setFormError(null);
                    }}
                  />
                </div>
                <div className="fr-field">
                  <label htmlFor="local-account-username">
                    Sacrum username
                  </label>
                  <input
                    id="local-account-username"
                    className="fr-input"
                    value={accountUsername}
                    onChange={(e) => {
                      setAccountUsername(e.target.value);
                      setFormError(null);
                    }}
                  />
                </div>
                <div className="fr-field">
                  <label htmlFor="local-account-password">
                    Sacrum password
                  </label>
                  <input
                    id="local-account-password"
                    className="fr-input"
                    type="password"
                    value={accountPassword}
                    onChange={(e) => {
                      setAccountPassword(e.target.value);
                      setFormError(null);
                    }}
                  />
                </div>
              </div>
              <div className="fr-callout">
                <span>
                  Vertebrae will provision the local backend after you continue.
                  It generates and stores backend secrets automatically.
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {!isLoading && setupView === "backend" && (
        <div className="space-y-4" data-testid="backend-choice">
          <button
            type="button"
            className={`w-full rounded-lg border p-4 text-left transition-colors ${
              backendChoice === "remote"
                ? "border-accent bg-bg-2"
                : "border-border hover:border-accent"
            }`}
            onClick={() => {
              setBackendChoice("remote");
              setFormError(null);
            }}
            data-testid="backend-choice-remote"
          >
            <div className="font-medium text-fg">
              Use an existing Sacrum backend
            </div>
            <div className="mt-1 text-sm text-fg-mute">
              Connect to a Sacrum URL with an API token you already have.
            </div>
          </button>
          <button
            type="button"
            className={`w-full rounded-lg border p-4 text-left transition-colors ${
              backendChoice === "local"
                ? "border-accent bg-bg-2"
                : "border-border hover:border-accent"
            }`}
            onClick={() => {
              setBackendChoice("local");
              setLocalAdoptionRequired(false);
              setLocalProgress(null);
              setFormError(null);
            }}
            data-testid="backend-choice-local"
          >
            <div className="font-medium text-fg">
              Run a local backend with Docker
            </div>
            <div className="mt-1 text-sm text-fg-mute">
              Keep Sacrum on this computer and let Vertebrae manage its stack.
            </div>
          </button>
        </div>
      )}

      {!isLoading && setupView === "ignition" && initializeResult && (
        <div className="fr-ignite" data-testid="ignition-screen">
          <div className="fr-flame" aria-hidden />
          <div className="fr-summary">
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
            <span>{initializeResult.path}</span>
          </div>
        </div>
      )}
    </FirstRunShell>
  );
}
