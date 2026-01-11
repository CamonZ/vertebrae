import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { commands, SavedProject } from "../bindings";
import { open } from "@tauri-apps/plugin-dialog";

export function ProjectSetupPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<SavedProject[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAddingProject, setIsAddingProject] = useState(false);

  // Load projects on mount
  const loadProjects = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.getProjects();
      if (result.status === "ok") {
        setProjects(result.data);
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

  // Handle selecting a project
  const handleSelectProject = async (project: SavedProject) => {
    if (!project.exists) {
      setError(`Project directory no longer exists: ${project.path}`);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.setCurrentProject(project.path);
      if (result.status === "ok") {
        navigate("/tasks");
      } else {
        setError(result.error.message);
      }
    } catch (e) {
      setError(`Failed to select project: ${e}`);
    } finally {
      setIsLoading(false);
    }
  };

  // Handle adding a new project
  const handleAddProject = async () => {
    setIsAddingProject(true);
    setError(null);

    try {
      // Open folder picker dialog
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Project Directory",
      });

      if (selected && typeof selected === "string") {
        // Extract project name from path
        const pathParts = selected.split("/");
        const projectName = pathParts[pathParts.length - 1] || "Unnamed Project";

        const result = await commands.addProject(projectName, selected);
        if (result.status === "ok") {
          // Reload projects list
          await loadProjects();
        } else {
          setError(result.error.message);
        }
      }
    } catch (e) {
      setError(`Failed to add project: ${e}`);
    } finally {
      setIsAddingProject(false);
    }
  };

  // Handle removing a project
  const handleRemoveProject = async (
    e: React.MouseEvent,
    project: SavedProject
  ) => {
    e.stopPropagation(); // Don't trigger selection

    try {
      const result = await commands.removeProject(project.path);
      if (result.status === "ok") {
        await loadProjects();
      } else {
        setError(result.error.message);
      }
    } catch (e) {
      setError(`Failed to remove project: ${e}`);
    }
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-bg-secondary p-8">
      <div className="w-full rounded-xl border border-border bg-bg-primary p-8 shadow-lg" style={{ maxWidth: '640px', minWidth: '400px' }}>
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="mb-2 text-3xl font-bold text-text-primary">
            Vertebrae
          </h1>
          <p className="text-text-secondary">
            Select a project to get started, or add a new one.
          </p>
        </div>

        {/* Error message */}
        {error && (
          <div className="mb-4 rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-center text-red-400">
            {error}
          </div>
        )}

        {/* Loading state */}
        {isLoading && (
          <div className="py-12 text-center text-text-secondary">
            Loading projects...
          </div>
        )}

        {/* Projects list */}
        {!isLoading && (
          <div className="mb-6 space-y-2">
            {projects.length === 0 ? (
              <div className="py-12 text-center text-text-secondary">
                No projects added yet. Add a project to get started.
              </div>
            ) : (
              projects.map((project) => (
                <div
                  key={project.path}
                  onClick={() => handleSelectProject(project)}
                  className={`flex cursor-pointer items-center justify-between rounded-lg border p-4 transition-colors ${
                    project.exists
                      ? "border-border hover:border-accent-secondary hover:bg-bg-tertiary"
                      : "cursor-not-allowed border-red-500/30 bg-red-500/5"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-text-primary">
                        {project.name}
                      </span>
                      {!project.exists && (
                        <span className="rounded bg-red-500/20 px-2 py-0.5 text-xs text-red-400">
                          Not Found
                        </span>
                      )}
                      {project.has_database && project.exists && (
                        <span className="rounded bg-green-500/20 px-2 py-0.5 text-xs text-green-400">
                          Database Ready
                        </span>
                      )}
                    </div>
                    <div className="mt-1 truncate text-sm text-text-tertiary">
                      {project.path}
                    </div>
                  </div>
                  <button
                    onClick={(e) => handleRemoveProject(e, project)}
                    className="ml-4 rounded p-2 text-text-tertiary transition-colors hover:bg-red-500/10 hover:text-red-400"
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

        {/* Add project button */}
        <button
          onClick={handleAddProject}
          disabled={isAddingProject}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-bg-tertiary px-4 py-3 text-text-secondary transition-colors hover:border-accent-secondary hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isAddingProject ? (
            "Selecting..."
          ) : (
            <>
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
                  d="M12 4v16m8-8H4"
                />
              </svg>
              Add Project
            </>
          )}
        </button>
      </div>
    </div>
  );
}
