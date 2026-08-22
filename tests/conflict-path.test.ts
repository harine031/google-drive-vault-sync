import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => path.replace(/\\/g, "/"),
  TFile: class {},
  TFolder: class {}
}));

import { conflictPath } from "../src/secure-sync-engine";

describe("conflict copy path", () => {
  it("places nested-file conflicts at the Vault root", () => {
    expect(conflictPath("folder/subfolder/note.md", "20260822-test"))
      .toBe("note.conflict-20260822-test.md");
    expect(conflictPath("folder/subfolder/note", "20260822-test"))
      .toBe("note.conflict-20260822-test");
  });
});
