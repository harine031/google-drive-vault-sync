const normalize = (path: string): string => path.replace(/\\/g, "/").replace(/^\/+/, "").normalize("NFC");
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const SAFE_CONFIG_FILES = new Set([
  "app.json",
  "appearance.json",
  "bookmarks.json",
  "core-plugins.json",
  "core-plugins-migration.json",
  "graph.json",
  "hotkeys.json",
  "templates.json",
  "types.json"
]);

export function isSafeVaultPath(inputPath: string): boolean {
  if (!inputPath || inputPath.length > 1024 || inputPath.includes("\\") || inputPath.startsWith("/") || /^[A-Za-z]:/.test(inputPath)) {
    return false;
  }
  const segments = inputPath.normalize("NFC").split("/");
  return segments.every((segment) =>
    segment.length > 0 &&
    segment.length <= 255 &&
    segment !== "." &&
    segment !== ".." &&
    !/[\u0000-\u001F<>:"|?*]/.test(segment) &&
    !/[ .]$/.test(segment) &&
    !WINDOWS_RESERVED.test(segment)
  );
}

export function canonicalVaultPath(path: string): string {
  return normalize(path).toLowerCase();
}

export function assertNoPathCollisions(paths: string[]): void {
  const seen = new Map<string, string>();
  for (const path of paths) {
    if (!isSafeVaultPath(path)) throw new Error(`${path}: クロスプラットフォームで安全でないパスです`);
    const canonical = canonicalVaultPath(path);
    const existing = seen.get(canonical);
    if (existing) throw new Error(`${existing} と ${path}: 同一またはクロスプラットフォーム上で衝突するパスです`);
    seen.set(canonical, path);
  }
}

export function assertNoCrossSidePathCollisions(localPaths: string[], remotePaths: string[]): void {
  assertNoPathCollisions(localPaths);
  assertNoPathCollisions(remotePaths);
  assertNoPathCollisions([...new Set([...localPaths, ...remotePaths])]);
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export function isPathExcluded(
  inputPath: string,
  includeObsidianConfig: boolean,
  excludePatterns: string[],
  configDir: string
): boolean {
  const path = normalize(inputPath);
  const normalizedConfigDir = normalize(configDir).replace(/\/$/, "");
  if (path === normalizedConfigDir || path.startsWith(`${normalizedConfigDir}/`)) {
    if (!includeObsidianConfig) return true;
    const relative = path.slice(normalizedConfigDir.length + 1);
    if (!relative || relative.includes("/") || !SAFE_CONFIG_FILES.has(relative)) return true;
  }
  return excludePatterns.some((pattern) => globToRegExp(normalize(pattern)).test(path));
}

export function shouldTraverseFolder(
  inputPath: string,
  includeObsidianConfig: boolean,
  excludePatterns: string[],
  configDir: string
): boolean {
  const folder = normalize(inputPath).replace(/\/$/, "");
  const normalizedConfigDir = normalize(configDir).replace(/\/$/, "");
  if (folder === normalizedConfigDir) return includeObsidianConfig;
  if (folder.startsWith(`${normalizedConfigDir}/`)) return false;
  const path = `${folder}/`;
  return !excludePatterns.some((pattern) => {
    const normalizedPattern = normalize(pattern);
    if (!normalizedPattern.endsWith("/**")) return false;
    return path.startsWith(normalizedPattern.slice(0, -2));
  });
}

export function mimeTypeForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const known: Record<string, string> = {
    md: "text/markdown",
    json: "application/json",
    canvas: "application/json",
    css: "text/css",
    js: "text/javascript",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    mp4: "video/mp4",
    mov: "video/quicktime"
  };
  return known[extension] ?? "application/octet-stream";
}
