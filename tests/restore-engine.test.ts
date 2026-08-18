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
import { DEFAULT_SETTINGS, DEFAULT_SYNC_STATE } from "../src/types";

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
});
