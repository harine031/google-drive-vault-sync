import { beforeEach, describe, expect, it, vi } from "vitest";

const { MockTFile, MockTFolder } = vi.hoisted(() => {
  class HoistedTFile {
    constructor(public path: string) {}
  }
  class HoistedTFolder {
    constructor(public path: string) {}
  }
  return { MockTFile: HoistedTFile, MockTFolder: HoistedTFolder };
});

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/+/g, "/"),
  TFile: MockTFile,
  TFolder: MockTFolder
}));

import { SyncEngine } from "../src/secure-sync-engine";
import { sha256Hex } from "../src/crypto-utils";
import { DEFAULT_SETTINGS, DEFAULT_SYNC_STATE, type RemoteFileInfo, type SyncStateData } from "../src/types";

describe("restore engine Obsidian indexing", () => {
  let entries: Map<string, InstanceType<typeof MockTFile> | InstanceType<typeof MockTFolder>>;
  let createdBinary: { path: string; bytes: ArrayBuffer } | null;

  beforeEach(() => {
    entries = new Map();
    createdBinary = null;
  });

  it("creates restored files through the Vault API so Obsidian indexes them immediately", async () => {
    const vault = {
      configDir: ".obsidian",
      adapter: {
        exists: vi.fn(async () => false),
        mkdir: vi.fn(async () => undefined),
        writeBinary: vi.fn(async () => undefined)
      },
      getAbstractFileByPath: vi.fn((path: string) => entries.get(path) ?? null),
      createFolder: vi.fn(async (path: string) => {
        entries.set(path, new MockTFolder(path));
      }),
      createBinary: vi.fn(async (path: string, bytes: ArrayBuffer) => {
        createdBinary = { path, bytes };
        const file = new MockTFile(path);
        entries.set(path, file);
        return file;
      }),
      modifyBinary: vi.fn(async () => undefined)
    };
    const app = { vault };
    const engine = new SyncEngine(
      app as never,
      structuredClone(DEFAULT_SETTINGS),
      structuredClone(DEFAULT_SYNC_STATE),
      {} as never,
      async () => undefined
    );
    const bytes = new TextEncoder().encode("restored note").buffer;

    await (engine as unknown as { writeLocal(path: string, value: ArrayBuffer): Promise<void> })
      .writeLocal("Notes/restored.md", bytes);

    expect(vault.createFolder).toHaveBeenCalledWith("Notes");
    expect(vault.createBinary).toHaveBeenCalledWith("Notes/restored.md", bytes);
    expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
    expect(createdBinary?.path).toBe("Notes/restored.md");
  });

  it("validates every local file before applying the first upload", async () => {
    const originalA = new TextEncoder().encode("aaa").buffer;
    const originalB = new TextEncoder().encode("bbb").buffer;
    const changedB = new TextEncoder().encode("ccc").buffer;
    const current = new Map<string, ArrayBuffer>([
      ["A.md", originalA],
      ["B.md", changedB]
    ]);
    const adapter = {
      list: vi.fn(async () => ({ files: ["A.md", "B.md"], folders: [] })),
      stat: vi.fn(async (path: string) => ({ type: "file", size: current.get(path)?.byteLength ?? 0 })),
      readBinary: vi.fn(async (path: string) => current.get(path) as ArrayBuffer),
      exists: vi.fn(async (path: string) => current.has(path))
    };
    const uploadEncrypted = vi.fn(async () => { throw new Error("upload must not run"); });
    const drive = {
      listVaultFiles: vi.fn(async () => []),
      uploadEncrypted
    };
    const engine = new SyncEngine(
      { vault: { configDir: ".obsidian", adapter } } as never,
      structuredClone(DEFAULT_SETTINGS),
      structuredClone(DEFAULT_SYNC_STATE),
      drive as never,
      async () => undefined
    );
    const plan = [
      {
        kind: "upload" as const,
        path: "A.md",
        local: { path: "A.md", hash: await sha256Hex(originalA), size: 3, mimeType: "text/markdown" },
        reason: "test"
      },
      {
        kind: "upload" as const,
        path: "B.md",
        local: { path: "B.md", hash: await sha256Hex(originalB), size: 3, mimeType: "text/markdown" },
        reason: "test"
      }
    ];

    await expect(engine.apply(plan)).rejects.toThrow("B.md");
    expect(uploadEncrypted).not.toHaveBeenCalled();
  });

  it("marks a verified Drive file as deleted when the local copy was removed", async () => {
    const remote: RemoteFileInfo = {
      id: "id-note",
      path: "note.md",
      hash: "a".repeat(64),
      size: 32,
      mimeType: "text/markdown",
      modifiedTime: "2026-08-19T00:00:00.000Z",
      encrypted: true,
      cipherHash: "b".repeat(64),
      iv: "AAAAAAAAAAAAAAAA"
    };
    const deleted = { ...remote, modifiedTime: "2026-08-19T00:01:00.000Z", deletedAt: "2026-08-19T00:01:00.000Z" };
    const state: SyncStateData = {
      records: { "note.md": { localHash: remote.hash, remoteHash: remote.hash, remoteFileId: remote.id } },
      lastSyncAt: null
    };
    const markDeleted = vi.fn(async () => deleted);
    const downloadVerified = vi.fn(async () => new ArrayBuffer(0));
    const drive = { listVaultFiles: vi.fn(async () => [remote]), downloadVerified, markDeleted };
    const app = { vault: { configDir: ".obsidian", adapter: { list: vi.fn(async () => ({ files: [], folders: [] })) } } };
    const engine = new SyncEngine(app as never, structuredClone(DEFAULT_SETTINGS), state, drive as never, async () => undefined);

    const result = await engine.apply([{ kind: "mark-delete", path: remote.path, remote, reason: "test" }]);

    expect(downloadVerified).toHaveBeenCalledWith(remote);
    expect(markDeleted).toHaveBeenCalledWith(remote);
    expect(result.applied).toBe(1);
    expect(state.records[remote.path]?.deletedAt).toBe(deleted.deletedAt);
  });

  it("preserves deletion evidence while migrating a previously synced legacy file", async () => {
    const legacy: RemoteFileInfo = {
      id: "id-legacy",
      path: "legacy.md",
      hash: "a".repeat(64),
      size: 10,
      mimeType: "text/markdown",
      modifiedTime: "2026-08-19T00:00:00.000Z",
      encrypted: false
    };
    const encrypted = {
      ...legacy,
      encrypted: true,
      size: 26,
      cipherHash: "b".repeat(64),
      iv: "AAAAAAAAAAAAAAAA",
      modifiedTime: "2026-08-19T00:01:00.000Z"
    };
    const state: SyncStateData = {
      records: { "legacy.md": { localHash: legacy.hash, remoteHash: legacy.hash, remoteFileId: legacy.id } },
      lastSyncAt: null
    };
    const drive = {
      listVaultFiles: vi.fn(async () => [legacy]),
      downloadLegacyVerified: vi.fn(async () => new ArrayBuffer(10)),
      uploadEncrypted: vi.fn(async () => encrypted)
    };
    const app = { vault: { configDir: ".obsidian", adapter: { list: vi.fn(async () => ({ files: [], folders: [] })) } } };
    const engine = new SyncEngine(app as never, structuredClone(DEFAULT_SETTINGS), state, drive as never, async () => undefined);

    await engine.apply([{ kind: "migrate", path: legacy.path, remote: legacy, reason: "test" }]);

    expect(state.records[legacy.path]).toMatchObject({
      localHash: legacy.hash,
      remoteHash: encrypted.hash,
      remoteFileId: encrypted.id
    });
  });

  it("moves an unchanged local file to Obsidian trash for a trusted tombstone", async () => {
    const bytes = new TextEncoder().encode("delete me").buffer;
    const hash = await sha256Hex(bytes);
    const file = new MockTFile("note.md");
    const remote: RemoteFileInfo = {
      id: "id-note",
      path: "note.md",
      hash,
      size: bytes.byteLength + 16,
      mimeType: "text/markdown",
      modifiedTime: "2026-08-19T00:01:00.000Z",
      encrypted: true,
      cipherHash: "b".repeat(64),
      iv: "AAAAAAAAAAAAAAAA",
      deletedAt: "2026-08-19T00:01:00.000Z"
    };
    const adapter = {
      list: vi.fn(async () => ({ files: ["note.md"], folders: [] })),
      stat: vi.fn(async () => ({ type: "file", size: bytes.byteLength })),
      readBinary: vi.fn(async () => bytes),
      exists: vi.fn(async (path: string) => path === "note.md"),
      mkdir: vi.fn(async () => undefined)
    };
    const rename = vi.fn(async () => undefined);
    const app = {
      vault: {
        configDir: ".obsidian",
        adapter,
        getAbstractFileByPath: vi.fn(() => file),
        rename
      }
    };
    const state: SyncStateData = {
      records: { "note.md": { localHash: hash, remoteHash: hash, remoteFileId: remote.id } },
      lastSyncAt: null
    };
    const downloadVerified = vi.fn(async () => bytes);
    const drive = { listVaultFiles: vi.fn(async () => [remote]), downloadVerified };
    const engine = new SyncEngine(app as never, structuredClone(DEFAULT_SETTINGS), state, drive as never, async () => undefined);
    const local = { path: "note.md", hash, size: bytes.byteLength, mimeType: "text/markdown" };

    const result = await engine.apply([{ kind: "delete-local", path: remote.path, local, remote, reason: "test" }]);

    expect(downloadVerified).toHaveBeenCalledWith(remote);
    expect(rename).toHaveBeenCalledWith(file, expect.stringMatching(/^\.trash\/google-drive-vault-sync\/.+\/note\.md$/));
    expect(downloadVerified.mock.invocationCallOrder[0]).toBeLessThan(rename.mock.invocationCallOrder[0]);
    expect(result.applied).toBe(1);
    expect(state.records[remote.path]?.deletedAt).toBe(remote.deletedAt);
  });
});
