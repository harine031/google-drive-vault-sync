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

    if (remote && !remote.encrypted) {
      const trustedByLocal = local?.hash === remote.hash;
      const trustedByState = record?.remoteHash === remote.hash && record.remoteFileId === remote.id;
      if (!trustedByLocal && !trustedByState) {
        return {
          kind: "skip",
          path,
          local,
          remote,
          reason: "旧平文ですが、信頼できるローカル原本または前回同期記録と一致しないため移行を保留"
        };
      }
      return {
        kind: "migrate",
        path,
        local,
        remote,
        reason: remote.excluded
          ? "旧平文を信頼済みhashで検証・暗号化し、以後は安全ポリシーで除外"
          : "旧平文をローカル原本または前回同期記録で検証して暗号化移行"
      };
    }

    if (remote?.excluded) {
      return { kind: "skip", path, local, remote, reason: "安全ポリシーの除外対象（DriveからVaultへは同期しません）" };
    }

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

export function buildRestorePlan(
  localFiles: LocalFileInfo[],
  remoteFiles: RemoteFileInfo[]
): SyncAction[] {
  const localByPath = new Map(localFiles.map((file) => [file.path, file]));
  const remoteByPath = new Map(remoteFiles.map((file) => [file.path, file]));
  const paths = [...new Set([...localByPath.keys(), ...remoteByPath.keys()])].sort();

  return paths.map((path): SyncAction => {
    const local = localByPath.get(path);
    const remote = remoteByPath.get(path);
    if (remote && !remote.encrypted) {
      return { kind: "skip", path, local, remote, reason: "旧平文です。先にWindowsで暗号化移行してください" };
    }
    if (remote?.excluded) {
      return { kind: "skip", path, local, remote, reason: "安全ポリシーの除外対象（復元しません）" };
    }
    if (remote && !local) {
      return { kind: "download", path, remote, reason: "Google Driveの暗号化バックアップからこのVaultへ復元" };
    }
    if (remote && local?.hash === remote.hash) {
      return { kind: "noop", path, local, remote, reason: "このVaultに同じ内容が存在" };
    }
    if (remote && local) {
      return { kind: "skip", path, local, remote, reason: "このVaultに異なる内容が存在するため復元では上書きしません" };
    }
    if (local && !remote) {
      return { kind: "skip", path, local, reason: "このVaultだけに存在するため復元ではアップロードしません" };
    }
    return { kind: "skip", path, local, remote, reason: "ファイル情報が不完全" };
  });
}
