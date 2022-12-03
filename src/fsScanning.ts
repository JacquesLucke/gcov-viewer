import * as vscode from "vscode";
import * as fs from "fs";
import { join } from "path";

function readdirOrEmpty(path: string) {
  return new Promise<string[]>((resolve) => {
    fs.readdir(path, (err, paths) => {
      if (err) {
        resolve([]);
      } else {
        resolve(paths);
      }
    });
  });
}

function statsOrUndefined(path: string) {
  return new Promise<undefined | fs.Stats>((resolve) => {
    fs.stat(path, (err, stats) => {
      if (err) {
        console.error(err);
        resolve(undefined);
      } else {
        resolve(stats);
      }
    });
  });
}

/**
 * Calls the given callback with every found file path in the given directory.
 * Other implementations return all paths at once, but the progress can't be
 * reported in the ui. Furthermore, this function can be cancelled by the user
 * if it takes too long.
 */
export async function findAllFilesRecursively(
  directory: string,
  callback: (path: string) => void,
  token?: vscode.CancellationToken
) {
  let fileNames: string[] = await readdirOrEmpty(directory);

  for (const fileName of fileNames) {
    const path = join(directory, fileName);
    const stats = await statsOrUndefined(path);
    if (stats === undefined) {
      continue;
    }
    if (stats.isFile()) {
      if (token?.isCancellationRequested) {
        return;
      }
      callback(path);
    } else {
      await findAllFilesRecursively(path, callback, token);
    }
  }
}
