import { describe, expect, it } from "vitest";
import { buildRestorePlan, buildSyncPlan } from "../src/sync-plan";
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

  it("uploads or downloads when only one side changed after the last sync", () => {
    const state: SyncStateData = {
      records: {
        "note.md": { localHash: "old", remoteHash: "old", remoteFileId: "id-note.md" }
      },
      lastSyncAt: null
    };

    expect(buildSyncPlan([local("note.md", "local-new")], [remote("note.md", "old")], state)[0]).toMatchObject({
      kind: "upload",
      reason: expect.stringContaining("ローカルだけ")
    });
    expect(buildSyncPlan([local("note.md", "old")], [remote("note.md", "remote-new")], state)[0]).toMatchObject({
      kind: "download",
      reason: expect.stringContaining("Driveだけ")
    });
  });

  it("creates a remote tombstone only for a locally deleted file matching the last sync", () => {
    const state: SyncStateData = {
      records: {
        "note.md": { localHash: "old", remoteHash: "old", remoteFileId: "id-note.md" }
      },
      lastSyncAt: null
    };
    const plan = buildSyncPlan([], [remote("note.md", "old")], state);
    expect(plan[0]).toMatchObject({ kind: "mark-delete", path: "note.md" });
  });

  it("does not turn a local deletion into a tombstone when Drive changed after the last sync", () => {
    const state: SyncStateData = {
      records: {
        "note.md": { localHash: "old", remoteHash: "old", remoteFileId: "id-note.md" }
      },
      lastSyncAt: null
    };
    const plan = buildSyncPlan([], [remote("note.md", "remote-new")], state);
    expect(plan[0]).toMatchObject({ kind: "skip", reason: expect.stringContaining("変更") });
  });

  it("propagates an authenticated tombstone only to an unchanged previously synced local file", () => {
    const state: SyncStateData = {
      records: {
        "note.md": { localHash: "old", remoteHash: "old", remoteFileId: "id-note.md" }
      },
      lastSyncAt: null
    };
    const deleted = { ...remote("note.md", "old"), deletedAt: "2026-08-19T00:00:00.000Z" };

    expect(buildSyncPlan([local("note.md", "old")], [deleted], state)[0]).toMatchObject({
      kind: "delete-local"
    });
    expect(buildSyncPlan([local("note.md", "local-new")], [deleted], state)[0]).toMatchObject({
      kind: "skip",
      reason: expect.stringContaining("編集")
    });
  });

  it("never deletes an untracked local file because of a remote tombstone", () => {
    const deleted = { ...remote("note.md", "old"), deletedAt: "2026-08-19T00:00:00.000Z" };
    const plan = buildSyncPlan([local("note.md", "old")], [deleted], { records: {}, lastSyncAt: null });
    expect(plan[0]).toMatchObject({ kind: "skip", reason: expect.stringContaining("同期記録") });
  });

  it("uploads a file recreated after this device acknowledged the tombstone", () => {
    const deletedAt = "2026-08-19T00:00:00.000Z";
    const state: SyncStateData = {
      records: {
        "note.md": { localHash: "old", remoteHash: "old", remoteFileId: "id-note.md", deletedAt }
      },
      lastSyncAt: null
    };
    const deleted = { ...remote("note.md", "old"), deletedAt };
    const plan = buildSyncPlan([local("note.md", "restored")], [deleted], state);
    expect(plan[0]).toMatchObject({ kind: "upload", reason: expect.stringContaining("復活") });
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

describe("restore plan", () => {
  it("downloads only encrypted Drive-only files", () => {
    const plan = buildRestorePlan(
      [local("local-only.md", "local"), local("same.md", "same")],
      [remote("remote-only.md", "remote"), remote("same.md", "same")]
    );
    expect(plan.find((action) => action.path === "remote-only.md")?.kind).toBe("download");
    expect(plan.find((action) => action.path === "local-only.md")?.kind).toBe("skip");
    expect(plan.find((action) => action.path === "same.md")?.kind).toBe("noop");
  });

  it("never restores a remote tombstone into a new Vault", () => {
    const deleted = { ...remote("deleted.md", "old"), deletedAt: "2026-08-19T00:00:00.000Z" };
    expect(buildRestorePlan([], [deleted])[0]).toMatchObject({
      kind: "skip",
      reason: expect.stringContaining("削除済み")
    });
  });

  it("never overwrites differing local content or restores excluded files", () => {
    const differing = remote("note.md", "remote");
    const excluded = { ...remote(".obsidian/plugins/example/data.json", "secret"), excluded: true };
    const plan = buildRestorePlan([local("note.md", "local")], [differing, excluded]);
    expect(plan.find((action) => action.path === "note.md")).toMatchObject({
      kind: "skip",
      reason: expect.stringContaining("上書きしません")
    });
    expect(plan.find((action) => action.path === excluded.path)).toMatchObject({
      kind: "skip",
      reason: expect.stringContaining("除外対象")
    });
  });

  it("blocks legacy plaintext until Windows migration completes", () => {
    const legacy = { ...remote("legacy.md", "same"), encrypted: false, cipherHash: undefined, iv: undefined };
    expect(buildRestorePlan([], [legacy])[0]).toMatchObject({
      kind: "skip",
      reason: expect.stringContaining("Windows")
    });
  });
});
