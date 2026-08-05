import { describe, expect, it } from "vitest";
import { isPathExcluded, isSafeVaultPath, mimeTypeForPath, shouldTraverseFolder } from "../src/path-policy";

const patterns = [
  ".trash/**",
  ".obsidian/workspace.json",
  ".obsidian/plugins/google-drive-vault-sync/**"
];

describe("path policy", () => {
  it("excludes device-local and self-plugin files", () => {
    expect(isPathExcluded(".obsidian/workspace.json", true, patterns)).toBe(true);
    expect(isPathExcluded(".obsidian/plugins/google-drive-vault-sync/data.json", true, patterns)).toBe(true);
    expect(isPathExcluded(".obsidian/plugins/calendar/data.json", true, patterns)).toBe(false);
  });

  it("can exclude all Obsidian configuration", () => {
    expect(isPathExcluded(".obsidian/themes/theme.css", false, patterns)).toBe(true);
    expect(isPathExcluded("Notes/example.md", false, patterns)).toBe(false);
  });

  it("skips excluded directory trees", () => {
    expect(shouldTraverseFolder(".trash", true, patterns)).toBe(false);
    expect(shouldTraverseFolder("Attachments", true, patterns)).toBe(true);
  });

  it("detects binary MIME types", () => {
    expect(mimeTypeForPath("image.PNG")).toBe("image/png");
    expect(mimeTypeForPath("document.pdf")).toBe("application/pdf");
    expect(mimeTypeForPath("unknown.bin")).toBe("application/octet-stream");
  });

  it("rejects paths that could escape the vault", () => {
    expect(isSafeVaultPath("Notes/safe.md")).toBe(true);
    expect(isSafeVaultPath("../outside.md")).toBe(false);
    expect(isSafeVaultPath("Notes/../../outside.md")).toBe(false);
    expect(isSafeVaultPath("C:/outside.md")).toBe(false);
    expect(isSafeVaultPath("/absolute.md")).toBe(false);
    expect(isSafeVaultPath("Notes\\windows.md")).toBe(false);
  });
});
