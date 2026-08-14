export interface LocalFileReference {
  path: string;
  line: number | null;
  column: number | null;
}

const LOCATION_RE = /^(.*?)(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?)$/;

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

function isContainedPath(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path).replace(/\/$/, "");
  const normalizedRoot = normalizePath(root).replace(/\/$/, "");
  if (!normalizedRoot || normalizedRoot === ".") return false;
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`)
  );
}

function hasFileLikeName(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  if (/^[^./][^/]*\.[A-Za-z0-9_-]+$/.test(name)) return true;
  if (/^(Dockerfile|Makefile|Procfile|LICENSE|README(?:\.md)?)$/i.test(name)) {
    return true;
  }
  return path.includes("/") && /^[A-Za-z0-9_.-]+$/.test(name);
}

/** Parse the narrow inline-code file contract used by local chat. */
export function parseLocalFileReference(
  value: string,
  projectRoot: string | null | undefined,
  allowedRoots: readonly string[] = []
): LocalFileReference | null {
  const root = projectRoot?.trim();
  if (!root) return null;

  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0") || /:\/\//.test(trimmed)) {
    return null;
  }

  const location = trimmed.match(LOCATION_RE);
  const rawPath = (location?.[1] ?? trimmed).trim();
  if (!rawPath || rawPath === "." || rawPath === "..") return null;

  const normalizedRoot = normalizePath(root).replace(/\/$/, "");
  const normalizedAllowedRoots = [normalizedRoot, ...allowedRoots]
    .map((allowedRoot) => normalizePath(allowedRoot).replace(/\/$/, ""))
    .filter(Boolean);
  const normalizedPath = normalizePath(rawPath);
  const candidate = isAbsolutePath(normalizedPath)
    ? normalizedPath
    : `${normalizedRoot}/${normalizedPath.replace(/^\.\//, "")}`;

  if (
    normalizedPath.startsWith("~") ||
    normalizedPath.split("/").includes("..") ||
    !normalizedAllowedRoots.some((allowedRoot) =>
      isContainedPath(candidate, allowedRoot)
    ) ||
    !hasFileLikeName(normalizedPath)
  ) {
    return null;
  }

  const line = Number(location?.[2] ?? location?.[4] ?? "");
  const column = Number(location?.[3] ?? location?.[5] ?? "");
  return {
    path: rawPath,
    line: Number.isSafeInteger(line) && line > 0 ? line : null,
    column: Number.isSafeInteger(column) && column > 0 ? column : null,
  };
}
