type InstallComponentAvailability = {
  installed_at_symlink: boolean;
  on_path: boolean;
};

type RequiredInstallComponents = {
  cli: InstallComponentAvailability;
  daemon: InstallComponentAvailability;
  gate: InstallComponentAvailability;
};

export function hasAllRequiredBinaries(status: RequiredInstallComponents): boolean {
  return [status.cli, status.daemon, status.gate].every(
    (component) => component.installed_at_symlink || component.on_path
  );
}
