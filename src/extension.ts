import * as vscode from 'vscode';
import * as fs from 'fs';
import * as util from 'util';
import * as os from 'os';
import { GcovData, GcovLineData, isGcovCompatible, loadGcovData } from './gcovInterface';
import { recursiveReaddir } from './fsScanning';
import { splitArrayInChunks, shuffleArray } from './arrayUtils';
import { assert } from 'console';

let isShowingDecorations: boolean = false;

export function activate(context: vscode.ExtensionContext) {
	const commands: [string, any][] = [
		['gcov-viewer.show', COMMAND_showDecorations],
		['gcov-viewer.hide', COMMAND_hideDecorations],
		['gcov-viewer.toggle', COMMAND_toggleDecorations],
		['gcov-viewer.reloadGcdaFiles', COMMAND_reloadGcdaFiles],
		['gcov-viewer.deleteGcdaFiles', COMMAND_deleteGcdaFiles],
		['gcov-viewer.selectIncludeDirectory', COMMAND_selectIncludeDirectory],
		['gcov-viewer.dumpPathsWithCoverageData', COMMAND_dumpPathsWithCoverageData],
	];

	for (const item of commands) {
		context.subscriptions.push(vscode.commands.registerCommand(item[0], item[1]));
	}

	vscode.window.onDidChangeVisibleTextEditors(async editors => {
		if (isShowingDecorations) {
			await COMMAND_showDecorations();
		}
	});
}

export function deactivate() { }

const calledLinesDecorationType = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: "rgba(50, 240, 50, 0.1)",
	overviewRulerColor: "rgba(50, 240, 50, 0.1)",
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

const missedLinesDecorationType = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: "rgba(240, 50, 50, 0.1)",
	overviewRulerColor: "rgba(240, 50, 50, 0.1)",
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

function getWorkspaceFolderConfig(workspaceFolder: vscode.WorkspaceFolder) {
	return vscode.workspace.getConfiguration('gcov_viewer', workspaceFolder);
}

function getIncludeDirectories(): string[] {
	if (vscode.workspace.workspaceFolders === undefined) {
		return [];
	}

	const includeDirectories: string[] = [];
	const workspaceFolderPaths: string[] = [];
	for (const workspaceFolder of vscode.workspace.workspaceFolders) {
		workspaceFolderPaths.push(workspaceFolder.uri.fsPath);
		const config = getWorkspaceFolderConfig(workspaceFolder);
		const dirs = config.get<string[]>('includeDirectories');
		if (dirs !== undefined) {
			for (let dir of dirs) {
				dir = dir.replace('${workspaceFolder}', workspaceFolder.uri.fsPath);
				includeDirectories.push(dir);
			}
		}
	}
	if (includeDirectories.length === 0) {
		includeDirectories.push(...workspaceFolderPaths);
	}
	return includeDirectories;
}

async function getGcdaPaths(progress?: MyProgress, token?: vscode.CancellationToken) {
	progress?.report({ message: 'Searching .gcda files' });
	const includeDirectories = getIncludeDirectories();

	let counter = 0;
	const gcdaPaths: Set<string> = new Set();
	for (const includeDirectory of includeDirectories) {
		await recursiveReaddir(includeDirectory, path => {
			if (path.endsWith('.gcda')) {
				gcdaPaths.add(path);
			}
			counter++;
			progress?.report({ message: `[${counter}] Scanning (found ${gcdaPaths.size}): ${path}` });
		}, token);
	}

	return Array.from(gcdaPaths);
}

function resetLoadedCoverageData() {
	linesByFile = new Map();
	demangledNames = new Map();
	loadedGcdaFiles = [];
}

let linesByFile: Map<string, GcovLineData[]>;
let demangledNames: Map<string, string>;
let loadedGcdaFiles: string[];
resetLoadedCoverageData();

type MyProgress = vscode.Progress<{ message?: string; increment?: number }>;

function handleLoadedGcovData(gcovData: GcovData) {
	for (const fileData of gcovData.files) {
		const lineDataArray = linesByFile.get(fileData.file);
		if (lineDataArray === undefined) {
			linesByFile.set(fileData.file, fileData.lines);
		}
		else {
			lineDataArray.push(...fileData.lines);
		}

		for (const functionData of fileData.functions) {
			demangledNames.set(functionData.name, functionData.demangled_name);
		}
	}
}

async function reloadCoverageDataFromPaths(
	paths: string[], totalPaths: number,
	progress: MyProgress,
	token: vscode.CancellationToken) {

	const chunks = splitArrayInChunks(paths, Math.ceil(paths.length / 30));
	for (const pathsChunk of chunks) {
		if (token.isCancellationRequested) {
			return;
		}

		const gcovDataArray = await loadGcovData(pathsChunk);
		for (const gcovData of gcovDataArray) {
			handleLoadedGcovData(gcovData);
		}
		loadedGcdaFiles.push(...pathsChunk);

		progress.report({
			increment: 100 * pathsChunk.length / totalPaths,
			message: `[${loadedGcdaFiles.length}/${totalPaths}] Parsing`
		});
	}
}

async function COMMAND_reloadGcdaFiles() {
	if (!await isGcovCompatible()) {
		return;
	}
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			cancellable: true,
			title: 'Reload Coverage Data',
		},
		async (progress, token) => {
			resetLoadedCoverageData();
			progress.report({ increment: 0 });

			const gcdaPaths = await getGcdaPaths(progress, token);
			shuffleArray(gcdaPaths);
			const pathChunks = splitArrayInChunks(gcdaPaths, os.cpus().length);

			const promises = [];
			for (const pathChunk of pathChunks) {
				promises.push(reloadCoverageDataFromPaths(
					pathChunk, gcdaPaths.length, progress, token));
			}
			await Promise.all(promises);
		}
	);
}

async function COMMAND_deleteGcdaFiles() {
	resetLoadedCoverageData();

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			cancellable: true,
			title: 'Delete .gcda files'
		},
		async (progress, token) => {
			await COMMAND_hideDecorations();
			progress.report({ increment: 0 });
			const paths = await getGcdaPaths(progress, token);
			const increment = 100 / paths.length;
			for (const [i, path] of paths.entries()) {
				if (token.isCancellationRequested) {
					return;
				}
				await util.promisify(fs.unlink)(path);
				progress.report({ increment: increment, message: `[${i}/${paths.length}] Delete` });
			}
		}
	);


}

async function COMMAND_toggleDecorations() {
	if (isShowingDecorations) {
		await COMMAND_hideDecorations();
	}
	else {
		await COMMAND_showDecorations();
	}
}

async function COMMAND_hideDecorations() {
	for (const editor of vscode.window.visibleTextEditors) {
		editor.setDecorations(calledLinesDecorationType, []);
		editor.setDecorations(missedLinesDecorationType, []);
	}
	isShowingDecorations = false;
}

async function COMMAND_showDecorations() {
	let found_decorations = false;
	for (const editor of vscode.window.visibleTextEditors) {
		found_decorations = found_decorations || await decorateEditor(editor);
	}
	if (found_decorations) {
		isShowingDecorations = true;
	}
}

function getLinesDataForFile(absolutePath: string) {
	const linesDataOfFile = linesByFile.get(absolutePath);
	if (linesDataOfFile !== undefined) {
		return linesDataOfFile;
	}
	for (const [storedPath, linesData] of linesByFile.entries()) {
		if (absolutePath.endsWith(storedPath)) {
			return linesData;
		}
	}
	return undefined;
}

function isCoverageDataLoaded() {
	return linesByFile.size > 0;
}

function groupDataPerLine(lines: GcovLineData[]): Map<number, GcovLineData[]> {
	const dataPerLine: Map<number, GcovLineData[]> = new Map();

	for (const lineData of lines) {
		const key = lineData.line_number;
		const data = dataPerLine.get(key);
		if (data === undefined) {
			dataPerLine.set(key, [lineData]);
		}
		else {
			data.push(lineData);
		}
	}

	return dataPerLine;
}

function groupDataPerFunction(lines: GcovLineData[]): Map<string, GcovLineData[]> {
	const dataPerFunction: Map<string, GcovLineData[]> = new Map();
	for (const lineData of lines) {
		const data = dataPerFunction.get(lineData.function_name);
		if (data === undefined) {
			dataPerFunction.set(lineData.function_name, [lineData]);
		}
		else {
			data.push(lineData);
		}
	}
	return dataPerFunction;
}

function sumTotalCalls(lines: GcovLineData[]): number {
	let sum = 0;
	for (const lineData of lines) {
		sum += lineData.count;
	}
	return sum;
}

function createRangeForLine(lineIndex: number) {
	return new vscode.Range(
		new vscode.Position(lineIndex, 0),
		new vscode.Position(lineIndex, 100000));
}

function createTooltipForExecutedLine(lineDataByFunction: Map<string, GcovLineData[]>) {
	let tooltip = '';
	for (const [functionName, dataArray] of lineDataByFunction.entries()) {
		let count = 0;
		for (const lineData of dataArray) {
			count += lineData.count;
		}
		const demangledName = demangledNames.get(functionName)!;
		tooltip += `${count.toLocaleString()}x in \`${demangledName}\`\n\n`;
	}
	return tooltip;
}

function createMissedLineDecoration(range: vscode.Range) {
	const decoration: vscode.DecorationOptions = {
		range: range,
		hoverMessage: 'Line has not been executed',
	};
	return decoration;
}

function createExecutedLineDecoration(range: vscode.Range, totalCalls: number, lineDataArray: GcovLineData[]) {
	const lineDataByFunction: Map<string, GcovLineData[]> = groupDataPerFunction(lineDataArray);
	let tooltip = createTooltipForExecutedLine(lineDataByFunction);
	const decoration: vscode.DecorationOptions = {
		range: range,
		hoverMessage: tooltip,
		renderOptions: {
			after: {
				contentText: `   ${totalCalls.toLocaleString()}x`,
				color: new vscode.ThemeColor('editorCodeLens.foreground'),
				fontStyle: 'italic',
			},
		},
	};
	return decoration;
}

class LineDecorationsGroup {
	calledLineDecorations: vscode.DecorationOptions[] = [];
	missedLineDecorations: vscode.DecorationOptions[] = [];
};

function createDecorationsForFile(linesDataOfFile: GcovLineData[]): LineDecorationsGroup {
	const decorations = new LineDecorationsGroup();

	const hitLines: Map<number, GcovLineData[]> = groupDataPerLine(linesDataOfFile);

	for (const lineDataArray of hitLines.values()) {
		const lineIndex = lineDataArray[0].line_number - 1;
		const range = createRangeForLine(lineIndex);
		const totalCalls = sumTotalCalls(lineDataArray);
		if (totalCalls === 0) {
			decorations.missedLineDecorations.push(createMissedLineDecoration(range));
		}
		else {
			decorations.calledLineDecorations.push(createExecutedLineDecoration(range, totalCalls, lineDataArray));
		}
	}

	return decorations;
}

async function decorateEditor(editor: vscode.TextEditor) {
	if (!isCoverageDataLoaded()) {
		await COMMAND_reloadGcdaFiles();
	}

	const path = editor.document.uri.fsPath;
	const linesDataOfFile = getLinesDataForFile(path);
	if (linesDataOfFile === undefined) {
		return false;
	}

	const decorations = createDecorationsForFile(linesDataOfFile);
	editor.setDecorations(calledLinesDecorationType, decorations.calledLineDecorations);
	editor.setDecorations(missedLinesDecorationType, decorations.missedLineDecorations);

	const decorationsAmount = decorations.calledLineDecorations.length + decorations.missedLineDecorations.length;
	return decorationsAmount > 0;
}

async function COMMAND_selectIncludeDirectory() {
	if (vscode.workspace.workspaceFolders === undefined) {
		return;
	}

	const value = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: true,
		openLabel: 'Select Include Directory'
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
		config.update('includeDirectories', paths);
	}
}

async function COMMAND_dumpPathsWithCoverageData() {
	if (vscode.workspace.workspaceFolders === undefined) {
		return;
	}

	if (!isCoverageDataLoaded()) {
		await COMMAND_reloadGcdaFiles();
	}

	const paths = Array.from(linesByFile.keys());
	paths.sort();
	const dumpedPaths = paths.join('\n');
	const document = await vscode.workspace.openTextDocument({
		content: dumpedPaths,
	});
	vscode.window.showTextDocument(document);
}
