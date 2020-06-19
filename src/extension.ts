import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as fs from 'fs';
import { join } from 'path';
import * as util from 'util';

let isShowingDecorations: boolean = false;

export function activate(context: vscode.ExtensionContext) {
	const commands: [string, any][] = [
		['gcov-viewer.show', COMMAND_showDecorations],
		['gcov-viewer.hide', COMMAND_hideDecorations],
		['gcov-viewer.toggle', COMMAND_toggleDecorations],
		['gcov-viewer.reloadCoverageData', COMMAND_reloadCoverageData],
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
});

interface LineData {
	count: number,
	function_name: string,
	line_number: number,
	unexecuted_block: boolean,
};

interface FunctionData {
	blocks: number,
	blocks_executed: number,
	demangled_name: string,
	start_column: number,
	start_line: number,
	end_column: number,
	end_line: number,
	execution_count: number,
	name: string,
};

interface GcovData {
	files: [{
		file: string,
		functions: FunctionData[],
		lines: LineData[],
	}],
	current_working_directory: string,
	data_file: string,
};

function getGcovBinary() {
	const config = vscode.workspace.getConfiguration('gcov_viewer', null);
	const gcovBinary = config.get<string>('gcovBinary');
	return gcovBinary;
}

async function isGcovCompatible() {
	const gcovBinary = getGcovBinary();
	const command = `${gcovBinary} --help`;
	return new Promise<boolean>((resolve, reject) => {
		child_process.exec(command, (err, stdout, stderr) => {
			if (err) {
				vscode.window.showErrorMessage(`Error while trying to run gcov: ${err}`);
				resolve(false);
				return;
			}
			const gcovOutput = stdout.toString();
			const supportsRequiredArgs = gcovOutput.includes('--json-format') && gcovOutput.includes('--stdout');
			if (!supportsRequiredArgs) {
				vscode.window.showErrorMessage(`The gcov version is not compatible. Please use at least version 9.`);
			}
			resolve(supportsRequiredArgs);
		});
	});
}

async function runGcov(paths: string[]) {
	if (paths.length === 0) {
		return [];
	}

	const gcovBinary = getGcovBinary();

	let command = `${gcovBinary} --stdout --json-format`;
	for (const path of paths) {
		command += ` "${path}"`;
	}
	return new Promise<GcovData[]>((resolve, reject) => {
		child_process.exec(command, { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				console.error(`exec error: ${err}`);
				reject();
				return;
			}
			const gcovOutput = stdout.toString();
			const output = [];
			const parts = gcovOutput.split('\n');
			for (const part of parts) {
				if (part.length === 0) {
					continue;
				}
				output.push(JSON.parse(part));
			}
			resolve(output);
		});
	});
}

function getWorkspaceFolderConfig(workspaceFolder: vscode.WorkspaceFolder) {
	return vscode.workspace.getConfiguration('gcov_viewer', workspaceFolder);
}

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

async function recursiveReaddir(basePath: string, callback: (path: string) => void, token?: vscode.CancellationToken) {
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

async function getGcdaPaths(progress?: MyProgress, token?: vscode.CancellationToken) {
	if (vscode.workspace.workspaceFolders === undefined) {
		return [];
	}

	progress?.report({ message: 'Searching .gcda files' });

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

	let counter = 0;
	const gcdaPaths: Set<string> = new Set();
	for (const basePath of includeDirectories) {
		await recursiveReaddir(basePath, path => {
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

let linesByFile: Map<string, LineData[]>;
let demangledNames: Map<string, string>;
let loadedGcdaFiles: string[];
resetLoadedCoverageData();

type MyProgress = vscode.Progress<{ message?: string; increment?: number }>;

async function reloadCoverageDataFromPaths(
	paths: string[], totalPaths: number,
	progress: MyProgress,
	token: vscode.CancellationToken) {

	if (paths.length > 30) {
		const middle = Math.floor(paths.length / 2);
		await reloadCoverageDataFromPaths(paths.slice(0, middle), totalPaths, progress, token);
		await reloadCoverageDataFromPaths(paths.slice(middle, paths.length), totalPaths, progress, token);
		return;
	}

	progress.report({ increment: 100 * paths.length / totalPaths, message: `[${loadedGcdaFiles.length}/${totalPaths}] Parsing` });
	const gcovDataArray = await runGcov(paths);
	for (const gcovData of gcovDataArray) {
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
	loadedGcdaFiles.push(...paths);
}

function shuffleArray(a: any[]) {
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

async function COMMAND_reloadCoverageData() {
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
			const asyncAmount = 20;
			const chunkSize = gcdaPaths.length / asyncAmount;

			const promises = [];
			for (let i = 0; i < asyncAmount; i++) {
				promises.push(reloadCoverageDataFromPaths(
					gcdaPaths.slice(i * chunkSize, (i + 1) * chunkSize), gcdaPaths.length, progress, token));
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

async function decorateEditor(editor: vscode.TextEditor) {
	if (!isCoverageDataLoaded()) {
		await COMMAND_reloadCoverageData();
	}

	const path = editor.document.uri.fsPath;
	const linesDataOfFile = getLinesDataForFile(path);
	if (linesDataOfFile === undefined) {
		return false;
	}

	const hitLines: Map<number, LineData[]> = new Map();

	for (const lineData of linesDataOfFile) {
		if (lineData.count > 0) {
			const key = lineData.line_number;
			const data = hitLines.get(key);
			if (data === undefined) {
				hitLines.set(key, [lineData]);
			}
			else {
				data.push(lineData);
			}
		}
	}

	const decorations: vscode.DecorationOptions[] = [];
	for (const [lineNumber, lineDataArray] of hitLines) {
		const lineIndex = lineNumber - 1;
		const range = new vscode.Range(
			new vscode.Position(lineIndex, 0),
			new vscode.Position(lineIndex, 100000));

		let totalCount = 0;
		const lineDataByFunction: Map<string, LineData[]> = new Map();
		for (const lineData of lineDataArray) {
			totalCount += lineData.count;
			const data = lineDataByFunction.get(lineData.function_name);
			if (data === undefined) {
				lineDataByFunction.set(lineData.function_name, [lineData]);
			}
			else {
				data.push(lineData);
			}
		}

		let tooltip = '';
		for (const [functionName, dataArray] of lineDataByFunction.entries()) {
			let count = 0;
			for (const lineData of dataArray) {
				count += lineData.count;
			}
			const demangledName = demangledNames.get(functionName)!;
			tooltip += `${count.toLocaleString()}x in \`${demangledName}\`\n\n`;
		}
		const decoration: vscode.DecorationOptions = {
			range: range,
			hoverMessage: tooltip,
			renderOptions: {
				after: {
					contentText: `   ${totalCount.toLocaleString()}x`,
					color: new vscode.ThemeColor('editorCodeLens.foreground'),
					fontStyle: 'italic',
				},
			},
		};
		decorations.push(decoration);
	}
	editor.setDecorations(calledLinesDecorationType, decorations);

	return decorations.length > 0;
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
		await COMMAND_reloadCoverageData();
	}

	const paths = Array.from(linesByFile.keys());
	paths.sort();
	const dumpedPaths = paths.join('\n');
	const document = await vscode.workspace.openTextDocument({
		content: dumpedPaths,
	});
	vscode.window.showTextDocument(document);


}
