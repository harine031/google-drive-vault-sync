import { describe, expect, it } from "vitest";
import {
  assertNoPathCollisions,
  isPathExcluded,
  isSafeVaultPath,
  mimeTypeForPath,
  shouldTraverseFolder
} from "../src/path-policy";

const patterns = [".trash/**"];
const configDir = ".obsidian";

describe("security path policy", () => {
  it("always excludes plugins, plugin data, themes, snippets and unknown config", () => {
    expect(isPathExcluded(".obsidian/plugins/google-drive-vault-sync/data.json", true, patterns, configDir)).toBe(true);
    expect(isPathExcluded(".obsidian/plugins/calendar/main.js", true, patterns, configDir)).toBe(true);
    expect(isPathExcluded(".obsidian/themes/theme.css", true, patterns, configDir)).toBe(true);
    expect(isPathExcluded(".obsidian/unknown-secret.json", true, patterns, configDir)).toBe(true);
    expect(isPathExcluded(".obsidian/hotkeys.json", true, patterns, configDir)).toBe(false);
  });

  it("excludes all Obsidian configuration by default", () => {
    expect(isPathExcluded(".obsidian/hotkeys.json", false, patterns, configDir)).toBe(true);
    expect(isPathExcluded("Notes/example.md", false, patterns, configDir)).toBe(false);
  });

  it("does not traverse config subdirectories", () => {
    expect(shouldTraverseFolder(".obsidian", true, patterns, configDir)).toBe(true);
    expect(shouldTraverseFolder(".obsidian/plugins", true, patterns, configDir)).toBe(false);
    expect(shouldTraverseFolder("Attachments", true, patterns, configDir)).toBe(true);
  });

  it("detects binary MIME types", () => {
    expect(mimeTypeForPath("image.PNG")).toBe("image/png");
    expect(mimeTypeForPath("document.pdf")).toBe("application/pdf");
    expect(mimeTypeForPath("unknown.bin")).toBe("application/octet-stream");
  });

  it("rejects traversal, Windows aliases, invalid characters and trailing dots", () => {
    expect(isSafeVaultPath("Notes/safe.md")).toBe(true);
    for (const path of ["../outside.md", "Notes/../../outside.md", "C:/outside.md", "/absolute.md", "Notes\\windows.md", "CON", "Notes/bad?.md", "Notes/trailing. "]) {
      expect(isSafeVaultPath(path)).toBe(false);
    }
  });

  it("rejects case-insensitive and Unicode-normalization collisions", () => {
    expect(() => assertNoPathCollisions(["Notes/A.md", "Notes/A.md"])).toThrow("衝突");
    expect(() => assertNoPathCollisions(["Notes/A.md", "notes/a.md"])).toThrow("衝突");
    expect(() => assertNoPathCollisions(["Notes/é.md", "Notes/é.md"])).toThrow("衝突");
  });
});
