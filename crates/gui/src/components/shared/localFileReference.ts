export interface LocalFileReference {
  path: string;
  line: number | null;
  column: number | null;
}

const LOCATION_RE =
  /^(.*?)(?::L?(\d+)(?:-\d+)?(?::(\d+))?|#L(\d+)(?:-L?\d+)?(?:C(\d+))?)$/;

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

function hasFileLikeName(path: string, explicitDestination = false): boolean {
  const name = path.split("/").pop() ?? "";

  // Dotfiles need stronger syntax than a method/property access.
  if (/^\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(name))
    return (
      /^(?:\.(?:env|gitignore|gitattributes|gitmodules|npmrc|nvmrc|editorconfig|prettierrc|eslintrc)(?:\.[A-Za-z0-9_-]+)?)$/.test(
        name
      ) || path.includes("/")
    );
  if (/[(){};=]/.test(name)) return false;
  // Bare version/model identifiers are not file intent. Explicit Markdown
  // destinations, paths and line anchors still support numeric extensions.
  if (
    /^[^./][^/]*\.[A-Za-z0-9_-]+$/.test(name) &&
    (explicitDestination ||
      path.includes("/") ||
      /\.[A-Za-z][A-Za-z0-9_-]*$/.test(name))
  )
    return true;
  if (/^(Dockerfile|Makefile|Procfile|LICENSE|README(?:\.md)?)$/i.test(name)) {
    return true;
  }
  return path.includes("/") && /^[A-Za-z0-9_.-]+$/.test(name);
}

/** A local line anchor must not be mistaken for a URI scheme. */
export function isLocalFileLocation(value: string): boolean {
  const path = value.match(LOCATION_RE)?.[1];
  return Boolean(path && !path.includes(":") && hasFileLikeName(path, true));
}

/** Parse the narrow inline-code file contract used by local chat. */
export function parseLocalFileReference(
  value: string,
  projectRoot: string | null | undefined,
  allowedRoots: readonly string[] = [],
  explicitDestination = false
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
    !hasFileLikeName(normalizedPath, explicitDestination || Boolean(location))
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

export interface ParsedFileDestination extends LocalFileReference {
  /** Explicit worktree identity, absent for an unqualified destination. */
  root: string | null;
}

/** Decode, validate and establish path identity once for preparation/probing. */
export function parseFileReferenceDestination(
  occurrence: { destination: string; syntax?: "inline" | "link" },
  projectRoot: string,
  roots: readonly string[]
): ParsedFileDestination | null {
  let destination: string;

  try {
    destination =
      occurrence.syntax === "inline"
        ? occurrence.destination
        : decodeURIComponent(occurrence.destination);
  } catch {
    return null;
  }

  const parsed = parseLocalFileReference(
    destination,
    projectRoot,
    roots,
    occurrence.syntax === "link"
  );

  if (!parsed) return null;

  const path = normalizePath(parsed.path).replace(/^\.\//, "");

  if (!isAbsolutePath(path)) return { ...parsed, path, root: null };

  const root = roots
    .filter((root) => isContainedPath(path, root) && path !== root)
    .sort((a, b) => b.length - a.length)[0];

  return root ? { ...parsed, root, path: path.slice(root.length + 1) } : null;
}
