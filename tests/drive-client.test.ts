import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestUrlMock } = vi.hoisted(() => ({ requestUrlMock: vi.fn() }));

vi.mock("obsidian", () => ({ requestUrl: requestUrlMock }));

import { decodeDrivePathProperties, encodeDrivePathProperties, GoogleDriveClient } from "../src/drive-client";

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

describe("Drive path properties", () => {
  beforeEach(() => requestUrlMock.mockReset());

  it("keeps a short path in the legacy single-property format", () => {
    const encoded = encodeDrivePathProperties("Notes/example.md");

    expect(encoded).toEqual({ path: "Notes/example.md" });
    expect(decodeDrivePathProperties(encoded as Record<string, string>)).toBe("Notes/example.md");
  });

  it("splits and restores a long Japanese path without exceeding Google's UTF-8 limit", () => {
    const path = `${"長い日本語フォルダー/".repeat(7)}葬祭資料.md`;
    expect(utf8Bytes(`path${path}`)).toBeGreaterThan(124);

    const encoded = encodeDrivePathProperties(path);
    const stored = Object.fromEntries(Object.entries(encoded).filter((entry): entry is [string, string] => entry[1] !== null));

    expect(encoded.path).toBeNull();
    expect(Number(stored.pathParts)).toBeGreaterThanOrEqual(2);
    for (const [key, value] of Object.entries(stored)) {
      expect(utf8Bytes(key + value)).toBeLessThanOrEqual(124);
    }
    expect(decodeDrivePathProperties(stored)).toBe(path);
  });

  it("rejects ambiguous or incomplete split path metadata", () => {
    expect(() => decodeDrivePathProperties({ path: "note.md", pathParts: "2", path0: "note", path1: ".md" }))
      .toThrow("重複");
    expect(() => decodeDrivePathProperties({ pathParts: "2", path0: "missing-second" }))
      .toThrow("不完全");
    expect(() => decodeDrivePathProperties({ pathParts: "2", path0: "a", path1: "b", path2: "extra" }))
      .toThrow("余分");
  });

  it("surfaces a sanitized Google Drive reason code for a failed upload", async () => {
    requestUrlMock
      .mockResolvedValueOnce(response(200, { files: [{ id: "folder", name: "Vault" }] }))
      .mockResolvedValueOnce(response(403, { error: { errors: [{ reason: "keyValuePairTooLarge" }] } }));
    const client = new GoogleDriveClient(
      async () => "access-token",
      () => "vault-id",
      () => "Vault",
      () => "A".repeat(43)
    );
    const bytes = new TextEncoder().encode("test").buffer;

    await expect(client.uploadEncrypted("note.md", bytes, "text/markdown", "a".repeat(64)))
      .rejects.toThrow("403: keyValuePairTooLarge");
  });
});

function response(status: number, json: unknown) {
  return { status, headers: {}, arrayBuffer: new ArrayBuffer(0), json, text: JSON.stringify(json) };
}
