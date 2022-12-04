import * as vscode from "vscode";
import * as fs from "fs";
import * as util from "util";
import * as os from "os";
import * as tmp from "tmp";
import * as fs_path from "path";
import {
  GcovLineData,
  isGcovCompatible,
  GcovFunctionData,
  GcovFileData,
} from "./gcovInterface";
import { findAllFilesRecursively } from "./fsScanning";
import { splitArrayInChunks, shuffleArray } from "./arrayUtils";
import {
  CoverageCache,
  FileCoverage,
  LineCoverage,
  FunctionCoverage,
} from "./coverageCache";

let isShowingDecorations: boolean = false;
let coverageStatusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  const commands: [string, any][] = [
    ["gcov-viewer.show", COMMAND_showDecorations],
    ["gcov-viewer.hide", COMMAND_hideDecorations],
    ["gcov-viewer.toggle", COMMAND_toggleDecorations],
    ["gcov-viewer.reloadGcdaFiles", COMMAND_reloadGcdaFiles],
    ["gcov-viewer.deleteGcdaFiles", COMMAND_deleteGcdaFiles],
    ["gcov-viewer.selectBuildDirectory", COMMAND_selectBuildDirectory],
    [
      "gcov-viewer.dumpPathsWithCoverageData",
      COMMAND_dumpPathsWithCoverageData,
    ],
    ["gcov-viewer.viewFunctionsByCallCount", COMMAND_viewFunctionsByCallCount],
    ["gcov-viewer.generateSummaryHTML", COMMAND_generateSummaryHTML],
  ];

  for (const item of commands) {
    context.subscriptions.push(
      vscode.commands.registerCommand(item[0], item[1])
    );
  }

  coverageStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  context.subscriptions.push(coverageStatusBarItem);

  vscode.window.onDidChangeVisibleTextEditors(async (editors) => {
    if (isShowingDecorations) {
      await COMMAND_showDecorations();
    }
  });
  vscode.workspace.onDidChangeConfiguration(async () => {
    if (isShowingDecorations) {
      await COMMAND_showDecorations();
    }
  });
  vscode.window.onDidChangeActiveTextEditor(updateStatusBar);
}

export function deactivate() {}

const calledLineColor = "rgba(50, 240, 50, 0.1)";
const calledLinesDecorationType = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: calledLineColor,
  overviewRulerColor: calledLineColor,
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

const missedLineColor = "rgba(240, 50, 50, 0.1)";
const missedLinesDecorationType = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: missedLineColor,
  overviewRulerColor: missedLineColor,
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

function getWorkspaceFolderConfig(workspaceFolder: vscode.WorkspaceFolder) {
  return vscode.workspace.getConfiguration("gcovViewer", workspaceFolder);
}

function getTextDocumentConfig(document: vscode.TextDocument) {
  return vscode.workspace.getConfiguration("gcovViewer", document);
}

function getBuildDirectories(): string[] {
  if (vscode.workspace.workspaceFolders === undefined) {
    return [];
  }

  const buildDirectories: string[] = [];
  const workspaceFolderPaths: string[] = [];
  for (const workspaceFolder of vscode.workspace.workspaceFolders) {
    workspaceFolderPaths.push(workspaceFolder.uri.fsPath);
    const config = getWorkspaceFolderConfig(workspaceFolder);
    const dirs = config.get<string[]>("buildDirectories");
    if (dirs !== undefined) {
      for (let dir of dirs) {
        dir = dir.replace("${workspaceFolder}", workspaceFolder.uri.fsPath);
        buildDirectories.push(dir);
      }
    }
  }
  if (buildDirectories.length === 0) {
    buildDirectories.push(...workspaceFolderPaths);
  }
  return buildDirectories;
}

async function getGcdaPaths(
  progress?: MyProgress,
  token?: vscode.CancellationToken
) {
  progress?.report({ message: "Searching .gcda files" });
  const buildDirectories = getBuildDirectories();

  let counter = 0;
  const gcdaPaths: Set<string> = new Set();
  for (const buildDirectory of buildDirectories) {
    await findAllFilesRecursively(
      buildDirectory,
      (path) => {
        if (path.endsWith(".gcda")) {
          gcdaPaths.add(path);
        }
        counter++;
        progress?.report({
          message: `[${counter}] Scanning (found ${gcdaPaths.size}): ${path}`,
        });
      },
      token
    );
  }

  return Array.from(gcdaPaths);
}

let coverageCache = new CoverageCache();

type MyProgress = vscode.Progress<{ message?: string; increment?: number }>;

async function reloadCoverageDataFromPaths(
  paths: string[],
  totalPaths: number,
  progress: MyProgress,
  token: vscode.CancellationToken
) {
  /* Process multiple paths per gcov invocation to avoid some overhead.
   * Don't process too many files at once so that the progress bar looks more active. */
  const chunks = splitArrayInChunks(paths, Math.ceil(paths.length / 30));
  for (const pathsChunk of chunks) {
    if (token.isCancellationRequested) {
      return;
    }

    await coverageCache.loadGcdaFiles(pathsChunk);

    progress.report({
      increment: (100 * pathsChunk.length) / totalPaths,
      message: `[${coverageCache.loadedGcdaFiles.length}/${totalPaths}] Parsing`,
    });
  }
}

function showNoFilesFoundMessage() {
  const message = `
		Cannot find any coverage data (.gcda files). Possible problems:
		1) You have not built your program with --coverage.
		2) The build directory is located somewhere else, you have to specify it using the button below.
		3) You have not run the program yet.
	`;

  vscode.window
    .showErrorMessage(message, "Select Build Directory")
    .then((value) => {
      if (value === "Select Build Directory") {
        COMMAND_selectBuildDirectory();
      }
    });
}

async function reloadGcdaFiles() {
  if (!(await isGcovCompatible())) {
    return;
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      cancellable: true,
      title: "Reload Coverage Data",
    },
    async (progress, token) => {
      coverageCache = new CoverageCache();
      progress.report({ increment: 0 });

      const gcdaPaths = await getGcdaPaths(progress, token);
      if (gcdaPaths.length === 0) {
        showNoFilesFoundMessage();
        return;
      }

      /* Shuffle paths make the processing time of the individual chunks more similar. */
      shuffleArray(gcdaPaths);
      const pathChunks = splitArrayInChunks(gcdaPaths, os.cpus().length);

      /* Process chunks asynchronously, so that gcov is invoked multiple times in parallel. */
      const promises = [];
      for (const pathChunk of pathChunks) {
        promises.push(
          reloadCoverageDataFromPaths(
            pathChunk,
            gcdaPaths.length,
            progress,
            token
          )
        );
      }
      await Promise.all(promises);
    }
  );
}

async function COMMAND_reloadGcdaFiles() {
  await reloadGcdaFiles();
  await showDecorations();
  updateStatusBar();
}

async function COMMAND_deleteGcdaFiles() {
  coverageCache = new CoverageCache();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      cancellable: true,
      title: "Delete .gcda files",
    },
    async (progress, token) => {
      await COMMAND_hideDecorations();
      isShowingDecorations = false;
      progress.report({ increment: 0 });
      const paths = await getGcdaPaths(progress, token);
      const increment = 100 / paths.length;
      for (const [i, path] of paths.entries()) {
        if (token.isCancellationRequested) {
          return;
        }
        await util.promisify(fs.unlink)(path);
        progress.report({
          increment: increment,
          message: `[${i}/${paths.length}] Delete`,
        });
      }
    }
  );
}

async function COMMAND_toggleDecorations() {
  if (isShowingDecorations) {
    await COMMAND_hideDecorations();
  } else {
    await COMMAND_showDecorations();
  }
}

async function COMMAND_hideDecorations() {
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(calledLinesDecorationType, []);
    editor.setDecorations(missedLinesDecorationType, []);
  }
  isShowingDecorations = false;
  updateStatusBar();
}

async function showDecorations() {
  for (const editor of vscode.window.visibleTextEditors) {
    await decorateEditor(editor);
  }
  if (coverageCache.hasData()) {
    isShowingDecorations = true;
  }
}

async function COMMAND_showDecorations() {
  if (!isCoverageDataLoaded()) {
    await reloadGcdaFiles();
  }
  await showDecorations();
  updateStatusBar();
}

function findCachedDataForFile(absolutePath: string): FileCoverage | undefined {
  /* Check if there is cached data for the exact path. */
  const dataOfFile = coverageCache.dataByFile.get(absolutePath);
  if (dataOfFile !== undefined) {
    return dataOfFile;
  }
  /* Path of win32 is case insensitive and path separators may be different. */
  if (os.platform() === "win32") {
    const absolutePathWin = absolutePath.replace(/\\/g, "/").toLowerCase();
    for (const [storedPath, dataOfFile] of coverageCache.dataByFile.entries()) {
      if (
        storedPath.toLowerCase() === absolutePathWin &&
        dataOfFile !== undefined
      ) {
        return dataOfFile;
      }
    }
  }
  /* Try to guess which cached data belongs to the given path.
   * This might have to be improved in the future when we learn more about
   * the ways this can fail. */
  for (const [storedPath, dataOfFile] of coverageCache.dataByFile.entries()) {
    if (absolutePath.endsWith(storedPath)) {
      return dataOfFile;
    }
  }
  return undefined;
}

function isCoverageDataLoaded() {
  return coverageCache.dataByFile.size > 0;
}

function groupData<T, Key>(
  values: T[],
  getKey: (value: T) => Key
): Map<Key, T[]> {
  const map: Map<Key, T[]> = new Map();
  for (const value of values) {
    const key: Key = getKey(value);
    if (map.get(key)?.push(value) === undefined) {
      map.set(key, [value]);
    }
  }
  return map;
}

function computeSum<T>(values: T[], getSummand: (value: T) => number) {
  return values.reduce((sum, value) => sum + getSummand(value), 0);
}

function sumTotalCalls(lines: GcovLineData[]): number {
  return computeSum(lines, (x) => x.count);
}

function createRangeForLine(lineIndex: number) {
  return new vscode.Range(
    new vscode.Position(lineIndex, 0),
    new vscode.Position(lineIndex, 100000)
  );
}

function createTooltipForCalledLine(
  lineDataByFunction: Map<string, GcovLineData[]>
) {
  const tooltipLinesWithCallCount: [string, number][] = [];
  for (const [functionName, dataArray] of lineDataByFunction.entries()) {
    let count = computeSum(dataArray, (x) => x.count);
    if (count > 0) {
      const demangledName = coverageCache.demangledNames.get(functionName)!;
      const tooltipLine = `${count.toLocaleString()}x in \`${demangledName}\`\n\n`;
      tooltipLinesWithCallCount.push([tooltipLine, count]);
    }
  }
  tooltipLinesWithCallCount.sort((a, b) => b[1] - a[1]);
  const tooltip = tooltipLinesWithCallCount.map((x) => x[0]).join("\n");
  return tooltip;
}

function createMissedLineDecoration(range: vscode.Range) {
  const decoration: vscode.DecorationOptions = {
    range: range,
    hoverMessage: "Line has not been executed",
  };
  return decoration;
}

function createCalledLineDecoration(
  range: vscode.Range,
  lineCoverage: LineCoverage,
  functionCoverage: FunctionCoverage | undefined
) {
  const calls = lineCoverage.executionCount;
  const isFunctionStart = functionCoverage !== undefined;
  const rawLineDataByFunction = groupData(
    lineCoverage.raw,
    (x) => x.function_name
  );
  const tooltip = createTooltipForCalledLine(rawLineDataByFunction);
  let text = `    ${calls.toLocaleString()}x`;
  if (isFunctionStart) {
    const coveratePercentage =
      (functionCoverage.calledLines / functionCoverage.totalLines) * 100;
    text += `[${Number(coveratePercentage).toFixed(1)}%]`;
  }
  const decoration: vscode.DecorationOptions = {
    range: range,
    hoverMessage: tooltip,
    renderOptions: {
      after: {
        contentText: text,
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
        fontStyle: "italic",
      },
    },
  };
  return decoration;
}

class LineDecorationsGroup {
  calledLineDecorations: vscode.DecorationOptions[] = [];
  missedLineDecorations: vscode.DecorationOptions[] = [];
}

function createDecorationsForFile(
  fileCoverage: FileCoverage
): LineDecorationsGroup {
  const decorations = new LineDecorationsGroup();

  fileCoverage.ensureAnalysed();

  for (let line = 0; line < fileCoverage.maxLine!; line++) {
    const lineCoverage = fileCoverage.dataByLine?.get(line);
    if (lineCoverage === undefined) {
      continue;
    }
    const functionCoverage = fileCoverage.functionsByStart?.get(line);
    const range = createRangeForLine(line);

    if (lineCoverage.executionCount === 0) {
      decorations.missedLineDecorations.push(createMissedLineDecoration(range));
    } else {
      decorations.calledLineDecorations.push(
        createCalledLineDecoration(range, lineCoverage, functionCoverage)
      );
    }
  }

  return decorations;
}

async function decorateEditor(editor: vscode.TextEditor) {
  const path = editor.document.uri.fsPath;
  const fileCoverage = findCachedDataForFile(path);
  if (fileCoverage === undefined) {
    return;
  }

  const config = getTextDocumentConfig(editor.document);

  const decorations = createDecorationsForFile(fileCoverage);
  editor.setDecorations(
    calledLinesDecorationType,
    decorations.calledLineDecorations
  );
  if (config.get<boolean>("highlightMissedLines")) {
    editor.setDecorations(
      missedLinesDecorationType,
      decorations.missedLineDecorations
    );
  } else {
    editor.setDecorations(missedLinesDecorationType, []);
  }
}

async function COMMAND_selectBuildDirectory() {
  if (vscode.workspace.workspaceFolders === undefined) {
    return;
  }

  const value = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: true,
    openLabel: "Select Build Directory",
  });
  if (value === undefined) {
    return;
  }

  const paths: string[] = [];
  for (const uri of value) {
    paths.push(uri.fsPath);
  }

  for (const workspaceFolder of vscode.workspace.workspaceFolders) {
    const config = getWorkspaceFolderConfig(workspaceFolder);
    config.update("buildDirectories", paths);
  }
}

async function COMMAND_dumpPathsWithCoverageData() {
  if (vscode.workspace.workspaceFolders === undefined) {
    return;
  }

  if (!isCoverageDataLoaded()) {
    await reloadGcdaFiles();
  }

  const paths = Array.from(coverageCache.dataByFile.keys());
  paths.sort();
  const dumpedPaths = paths.join("\n");
  const document = await vscode.workspace.openTextDocument({
    content: dumpedPaths,
  });
  vscode.window.showTextDocument(document);
}

async function COMMAND_generateSummaryHTML() {
  if (!isCoverageDataLoaded()) {
    await reloadGcdaFiles();
  }

  const data = [];
  for (const [path, fileCoverage] of coverageCache.dataByFile.entries()) {
    fileCoverage.ensureAnalysed();
    const functionData = [];
    for (const functionCoverage of fileCoverage.functionsByStart!.values()) {
      functionData.push({
        name: functionCoverage.baseName,
        total: functionCoverage.totalLines,
        called: functionCoverage.calledLines,
      });
    }
    data.push({
      path,
      total: fileCoverage.totalLines,
      called: fileCoverage.calledLines,
      functions: functionData,
    });
  }

  const template = fs.readFileSync(
    fs_path.join(
      fs_path.dirname(__dirname),
      "html_report",
      "overview_template.html"
    ),
    "utf8"
  );
  const coverageDump = template.replace(
    "// analysisData = [{ dummy: 42 }];",
    `analysisData = ${JSON.stringify(data)}`
  );

  tmp.file({ postfix: ".html" }, (err, path) => {
    fs.writeFileSync(path, coverageDump);
    vscode.env.openExternal(vscode.Uri.file(path));
  });
}

async function COMMAND_viewFunctionsByCallCount() {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    return;
  }

  if (!isCoverageDataLoaded()) {
    await reloadGcdaFiles();
  }

  const fileCoverage = findCachedDataForFile(editor.document.uri.fsPath);
  if (fileCoverage === undefined) {
    return;
  }

  interface FunctionPickItem extends vscode.QuickPickItem {
    functionCoverage: FunctionCoverage;
  }

  fileCoverage.ensureAnalysed();

  let items: FunctionPickItem[] = [];
  for (const functionCoverage of fileCoverage.functionsByStart!.values()) {
    items.push({
      label: `${functionCoverage.executionCount.toLocaleString()}x ${
        functionCoverage.baseName
      }`,
      functionCoverage,
    });
  }
  items.sort(
    (a, b) =>
      b.functionCoverage.executionCount - a.functionCoverage.executionCount
  );

  const quickPick = vscode.window.createQuickPick();
  quickPick.items = items;
  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.onDidChangeSelection(() => quickPick.hide());
  quickPick.onDidChangeActive((items) => {
    const functionCoverage = (items[0] as FunctionPickItem).functionCoverage;
    const startLine = functionCoverage.startLine;
    const endLine = functionCoverage.endLine;
    editor.selection = new vscode.Selection(
      new vscode.Position(startLine, 0),
      new vscode.Position(startLine, 0)
    );
    editor.revealRange(
      new vscode.Range(startLine, 0, endLine, 0),
      vscode.TextEditorRevealType.InCenter
    );
  });
  quickPick.show();
}

function updateStatusBar() {
  coverageStatusBarItem.hide();
  if (!isCoverageDataLoaded()) {
    return;
  }
  if (!isShowingDecorations) {
    return;
  }
  const path = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (path === undefined) {
    return;
  }
  const fileCoverage = findCachedDataForFile(path);
  if (fileCoverage === undefined) {
    return;
  }
  fileCoverage.ensureAnalysed();

  const percentage =
    fileCoverage.totalLines! === 0
      ? 100
      : (fileCoverage.calledLines! / fileCoverage.totalLines!) * 100;
  coverageStatusBarItem.text = `Coverage: ${fileCoverage.calledLines!}/${fileCoverage.totalLines!} [${percentage.toFixed(
    1
  )}%]`;
  coverageStatusBarItem.show();
}
