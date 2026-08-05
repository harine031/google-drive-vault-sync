const normalize = (path: string): string => path.replace(/\\/g, "/").replace(/^\/+/, "");

export function isSafeVaultPath(inputPath: string): boolean {
  if (!inputPath || inputPath.includes("\\") || inputPath.startsWith("/") || /^[A-Za-z]:/.test(inputPath)) {
    return false;
  }
  const segments = inputPath.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\0"));
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
  excludePatterns: string[]
): boolean {
  const path = normalize(inputPath);
  if (!includeObsidianConfig && (path === ".obsidian" || path.startsWith(".obsidian/"))) {
    return true;
  }
  return excludePatterns.some((pattern) => globToRegExp(normalize(pattern)).test(path));
}

export function shouldTraverseFolder(
  inputPath: string,
  includeObsidianConfig: boolean,
  excludePatterns: string[]
): boolean {
  const path = `${normalize(inputPath).replace(/\/$/, "")}/`;
  if (!includeObsidianConfig && path.startsWith(".obsidian/")) return false;
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
