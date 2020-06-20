import * as vscode from 'vscode';
import * as fs from 'fs';
import { join, dirname } from 'path';
import { assert } from 'console';

function readdirOrEmpty(path: string) {
    return new Promise<string[]>(resolve => {
        fs.readdir(path, (err, paths) => {
            if (err) {
                resolve([]);
            }
            else {
                resolve(paths);
            }
        });
    });
}

function statsOrUndefined(path: string) {
    return new Promise<undefined | fs.Stats>(resolve => {
        fs.stat(path, (err, stats) => {
            if (err) {
                console.error(err);
                resolve(undefined);
            }
            else {
                resolve(stats);
            }
        });
    });
}

export async function recursiveReaddir(basePath: string, callback: (path: string) => void, token?: vscode.CancellationToken) {
    let fileNames: string[] = await readdirOrEmpty(basePath);

    for (const fileName of fileNames) {
        const path = join(basePath, fileName);
        const stats = await statsOrUndefined(path);
        if (stats === undefined) {
            continue;
        }
        if (stats.isFile()) {
            if (token?.isCancellationRequested) {
                return;
            }
            callback(path);
        }
        else {
            await recursiveReaddir(path, callback, token);
        }
    }
}

export async function getNeighboringDirectories(currentPath: string) {
    const parentPath = dirname(currentPath);
    let fileNames = await readdirOrEmpty(parentPath);
    assert(fileNames.length >= 1);

    const neighboringDirectories = [];
    for (const fileName of fileNames) {
        const path = join(parentPath, fileName);
        const stats = await statsOrUndefined(path);
        if (stats === undefined) {
            continue;
        }
        if (stats.isDirectory()) {
            neighboringDirectories.push(path);
        }
    }

    return neighboringDirectories;
}
