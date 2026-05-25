import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { commands, InstallationStatus } from "../bindings";

type Phase = "loading" | "ready" | "installing" | "success" | "error";

/**
 * First-run welcome screen. Asks the user for permission to install the
 * bundled `vtb` (CLI) and `vtb-daemon` (background workflow runner)
 * sidecars into `~/.local/bin`.
 *
 * This page is intentionally rendered OUTSIDE both `InstallationGuard` and
 * `ProjectGuard` — `InstallationGuard` would otherwise create a redirect
 * loop, and we want users to see this before being asked to pick a project.
 */
export function WelcomeInstallPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState<InstallationStatus | null>(null);
  const [installCli, setInstallCli] = useState(true);
  const [installDaemon, setInstallDaemon] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Compute "where do we go after the user decides?" — if they already
  // picked a project on a previous launch we send them home; otherwise to
  // the project setup screen.
  const proceedAfterDecision = useCallback(async () => {
    try {
      const result = await commands.hasProjectSelected();
      if (result.status === "ok" && result.data) {
        navigate("/", { replace: true });
        return;
      }
    } catch {
      // fall through to setup
    }
    navigate("/setup", { replace: true });
  }, [navigate]);

  // Load initial installation status so we can pre-check the boxes and
  // surface the symlink target paths.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const result = await commands.installationStatus();
        if (cancelled) return;
        if (result.status === "ok") {
          setStatus(result.data);
          // Pre-check OFF for any component that's already installed at
          // our symlink path — the user shouldn't have to re-pick it.
          setInstallCli(!result.data.cli.installed_at_symlink);
          setInstallDaemon(!result.data.daemon.installed_at_symlink);
          setPhase("ready");
        } else {
          setError(result.error.message);
          setPhase("error");
        }
      } catch (e) {
        if (cancelled) return;
        setError(`Failed to query installation status: ${e}`);
        setPhase("error");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleInstall = async () => {
    setPhase("installing");
    setError(null);
    try {
      const result = await commands.installComponents(
        installCli,
        installDaemon
      );
      if (result.status === "ok") {
        setStatus(result.data);
        setPhase("success");
        // Brief success state so the user sees confirmation before we move on.
        setTimeout(() => {
          proceedAfterDecision();
        }, 600);
      } else {
        setError(result.error.message);
        setPhase("error");
      }
    } catch (e) {
      setError(`Install failed: ${e}`);
      setPhase("error");
    }
  };

  const handleCancel = async () => {
    setError(null);
    try {
      await commands.quitApplication();
    } catch (e) {
      setError(`Failed to quit: ${e}`);
      setPhase("error");
    }
  };

  const isBusy = phase === "installing" || phase === "loading";
  const installButtonDisabled =
    isBusy || (!installCli && !installDaemon);
  const nothingToInstall =
    status !== null &&
    status.cli.installed_at_symlink &&
    status.daemon.installed_at_symlink;

  return (
    <div
      className="flex h-screen w-screen items-center justify-center bg-bg-secondary p-8"
      data-testid="welcome-page"
    >
      <div
        className="w-full rounded-xl border border-border bg-bg-primary p-8 shadow-lg"
        style={{ maxWidth: "640px", minWidth: "400px" }}
      >
        <div className="mb-6 text-center">
          <h1
            className="mb-2 text-3xl font-bold text-primary"
            data-testid="welcome-heading"
          >
            Welcome to Vertebrae
          </h1>
          <p className="text-text-secondary">
            Vertebrae needs to install its command-line tools — the{" "}
            <span className="font-mono">vtb</span> CLI and the{" "}
            <span className="font-mono">vtb-daemon</span> background runner — on
            your system before you can continue. Review what will be installed
            below and choose Install to proceed.
          </p>
        </div>

        {phase === "loading" && (
          <div
            className="py-12 text-center text-text-secondary"
            data-testid="welcome-loading"
          >
            Checking installation status...
          </div>
        )}

        {status !== null && phase !== "loading" && (
          <div className="mb-6 space-y-3">
            <ComponentRow
              testId="welcome-cli"
              label="vtb CLI"
              description="The vertebrae command-line tool used to manage tasks and workflows."
              targetPath={status.cli.symlink_path}
              alreadyInstalled={status.cli.installed_at_symlink}
              onPath={status.cli.on_path}
              checked={installCli}
              disabled={isBusy}
              onChange={setInstallCli}
            />
            <ComponentRow
              testId="welcome-daemon"
              label="vtb-daemon"
              description="The background workflow runner that executes agents."
              targetPath={status.daemon.symlink_path}
              alreadyInstalled={status.daemon.installed_at_symlink}
              onPath={status.daemon.on_path}
              checked={installDaemon}
              disabled={isBusy}
              onChange={setInstallDaemon}
            />
          </div>
        )}

        {error && (
          <div
            className="mb-4 rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-center text-red-400"
            data-testid="welcome-error"
          >
            {error}
          </div>
        )}

        {phase === "installing" && (
          <div
            className="mb-4 rounded-lg border border-border bg-bg-tertiary p-3 text-center text-text-secondary"
            data-testid="welcome-installing"
          >
            Installing components...
          </div>
        )}

        {phase === "success" && (
          <div
            className="mb-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-center text-emerald-300"
            data-testid="welcome-success"
          >
            Install complete. Continuing...
          </div>
        )}

        <div className="flex items-center justify-end gap-3">
          <button
            onClick={handleCancel}
            disabled={isBusy}
            className="rounded-lg border border-border bg-bg-tertiary px-4 py-2 text-text-secondary transition-colors hover:border-accent-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="welcome-cancel"
          >
            Cancel
          </button>
          <button
            onClick={handleInstall}
            disabled={installButtonDisabled || nothingToInstall}
            className="rounded-lg bg-primary px-4 py-2 font-medium text-bg-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="welcome-install"
          >
            {phase === "installing" ? "Installing..." : "Install"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ComponentRowProps {
  testId: string;
  label: string;
  description: string;
  targetPath: string;
  alreadyInstalled: boolean;
  onPath: boolean;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}

function ComponentRow({
  testId,
  label,
  description,
  targetPath,
  alreadyInstalled,
  onPath,
  checked,
  disabled,
  onChange,
}: ComponentRowProps) {
  return (
    <label
      className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-bg-tertiary p-4 transition-colors hover:border-accent-secondary"
      data-testid={testId}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled || alreadyInstalled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
        data-testid={`${testId}-checkbox`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-text-primary">{label}</span>
          {alreadyInstalled && (
            <span
              className="rounded bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300"
              data-testid={`${testId}-already-installed`}
            >
              already installed
            </span>
          )}
          {!alreadyInstalled && onPath && (
            <span
              className="rounded bg-bg-primary px-2 py-0.5 text-xs text-text-tertiary"
              data-testid={`${testId}-on-path`}
            >
              found on PATH
            </span>
          )}
        </div>
        <div className="mt-1 text-sm text-text-secondary">{description}</div>
        <div className="mt-2 truncate font-mono text-xs text-text-tertiary">
          {targetPath}
        </div>
      </div>
    </label>
  );
}
