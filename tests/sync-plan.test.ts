import { describe, expect, it } from "vitest";
import { buildSyncPlan } from "../src/sync-plan";
import type { LocalFileInfo, RemoteFileInfo, SyncStateData } from "../src/types";

const local = (path: string, hash: string): LocalFileInfo => ({
  path,
  hash,
  size: 1,
  mimeType: "text/markdown"
});

const remote = (path: string, hash: string): RemoteFileInfo => ({
  id: `id-${path}`,
  path,
  hash,
  size: 1,
  mimeType: "text/markdown",
  modifiedTime: "2026-08-03T00:00:00Z",
  encrypted: true,
  cipherHash: "c".repeat(64),
  iv: "AAAAAAAAAAAAAAAA"
});

describe("sync plan", () => {
  it("uploads and downloads one-sided new files", () => {
    const plan = buildSyncPlan([local("local.md", "a")], [remote("remote.md", "b")], { records: {}, lastSyncAt: null });
    expect(plan.map((action) => action.kind)).toEqual(["upload", "download"]);
  });

  it("detects a two-sided edit as a conflict", () => {
    const state: SyncStateData = {
      records: {
        "note.md": { localHash: "old", remoteHash: "old", remoteFileId: "id-note" }
      },
      lastSyncAt: null
    };
    const plan = buildSyncPlan([local("note.md", "local-new")], [remote("note.md", "remote-new")], state);
    expect(plan[0].kind).toBe("conflict");
  });

  it("never propagates deletion in the MVP", () => {
    const state: SyncStateData = {
      records: {
        "note.md": { localHash: "old", remoteHash: "old", remoteFileId: "id-note" }
      },
      lastSyncAt: null
    };
    const plan = buildSyncPlan([], [remote("note.md", "old")], state);
    expect(plan[0].kind).toBe("skip");
  });

  it("migrates plaintext files trusted by a local copy or previous sync state", () => {
    const legacy = { ...remote("note.md", "same"), encrypted: false, cipherHash: undefined, iv: undefined };
    expect(buildSyncPlan([local("note.md", "same")], [legacy], { records: {}, lastSyncAt: null })[0]).toMatchObject({
      kind: "migrate",
      reason: expect.stringContaining("暗号化移行")
    });
    expect(buildSyncPlan([], [legacy], {
      records: { "note.md": { localHash: "old", remoteHash: "same", remoteFileId: legacy.id } },
      lastSyncAt: null
    })[0]).toMatchObject({ kind: "migrate" });
    expect(buildSyncPlan([], [legacy], { records: {}, lastSyncAt: null })[0]).toMatchObject({
      kind: "skip",
      reason: expect.stringContaining("信頼できる")
    });
  });

  it("keeps excluded remote files out of normal sync after migration", () => {
    const excluded = { ...remote(".obsidian/plugins/example/data.json", "same"), excluded: true };
    expect(buildSyncPlan([], [excluded], { records: {}, lastSyncAt: null })[0]).toMatchObject({
      kind: "skip",
      reason: expect.stringContaining("除外対象")
    });
  });
});
