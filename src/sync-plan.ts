import type {
  LocalFileInfo,
  RemoteFileInfo,
  SyncAction,
  SyncStateData
} from "./types";

export function buildSyncPlan(
  localFiles: LocalFileInfo[],
  remoteFiles: RemoteFileInfo[],
  state: SyncStateData
): SyncAction[] {
  const localByPath = new Map(localFiles.map((file) => [file.path, file]));
  const remoteByPath = new Map(remoteFiles.map((file) => [file.path, file]));
  const paths = [...new Set([...localByPath.keys(), ...remoteByPath.keys()])].sort();

  return paths.map((path): SyncAction => {
    const local = localByPath.get(path);
    const remote = remoteByPath.get(path);
    const record = state.records[path];

    if (local && !remote) {
      if (record?.remoteFileId) {
        return { kind: "skip", path, local, reason: "Drive側の削除を検出。MVPでは自動復元・自動削除しません" };
      }
      return { kind: "upload", path, local, reason: "ローカルだけに存在" };
    }

    if (!local && remote) {
      if (record) {
        return { kind: "skip", path, remote, reason: "ローカル側の削除を検出。MVPでは自動復元・自動削除しません" };
      }
      return { kind: "download", path, remote, reason: "Driveだけに存在" };
    }

    if (!local || !remote) {
      return { kind: "skip", path, local, remote, reason: "ファイル情報が不完全" };
    }

    if (local.hash === remote.hash) {
      return { kind: "noop", path, local, remote, reason: "内容が一致" };
    }

    if (!record) {
      return { kind: "conflict", path, local, remote, reason: "初回比較で両方に異なる内容が存在" };
    }

    const conflictPair = `${local.hash}:${remote.hash}`;
    if (record.lastConflictPair === conflictPair) {
      return { kind: "noop", path, local, remote, reason: "同じ競合は退避済み" };
    }

    const localChanged = local.hash !== record.localHash;
    const remoteChanged = remote.hash !== record.remoteHash;
    if (localChanged && !remoteChanged) {
      return { kind: "upload", path, local, remote, reason: "ローカルだけが変更" };
    }
    if (!localChanged && remoteChanged) {
      return { kind: "download", path, local, remote, reason: "Driveだけが変更" };
    }
    return { kind: "conflict", path, local, remote, reason: "両方で変更または同期状態が不一致" };
  });
}
