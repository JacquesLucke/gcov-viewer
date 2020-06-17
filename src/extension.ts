import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as recursive_readdir from "recursive-readdir";

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand("gcov-viewer.show", show_decorations));
	context.subscriptions.push(vscode.commands.registerCommand("gcov-viewer.load_coverage_data", load_coverage_data));
	context.subscriptions.push(vscode.commands.registerCommand("gcov-viewer.delete_coverage_data", delete_coverage_data));
}

export function deactivate() { }

const decorationType = vscode.window.createTextEditorDecorationType({
	backgroundColor: 'rgba(50, 240, 50, 0.2)',
	isWholeLine: true,
	cursor: "crosshair"
});

interface LineData {
	count: number,
	function_name: string,
	line_number: number,
	unexecuted_block: boolean,
};

interface LinesByFile {
	[key: string]: [LineData]
};

let lines_by_file: LinesByFile = {};

interface GcovJson {
	files: [{
		file: string,
		functions: [{
			blocks: number,
			blocks_executed: number,
			demangled_name: string,
			start_column: number,
			start_line: number,
			end_column: number,
			end_line: number,
			execution_count: number,
			name: string,
		}],
		lines: [LineData],
	}],
	current_working_directory: string,
	data_file: string,
};

async function run_gcov(path: string) {
	const command = `gcov --stdout --json-format "${path}"`;
	return new Promise<GcovJson>((resolve, reject) => {
		child_process.exec(command, { maxBuffer: 1024 * 1024 * 128 }, (error, stdout, stderr) => {
			if (error) {
				console.error(`exec error: ${error}`);
				reject();
				return;
			}
			const gcov_output = stdout.toString();
			const gcov_data = JSON.parse(gcov_output);
			resolve(gcov_data);
		});
	});
}

async function* get_gcda_paths() {
	const base_path = "/home/jacques/blender-git/build_linux/";
	const paths = await recursive_readdir(base_path);
	for (const path of paths) {
		if (path.endsWith(".gcda")) {
			yield path;
		}
	}
}

async function load_coverage_data() {
	lines_by_file = {};

	for await (const path of get_gcda_paths()) {
		console.log(path);
		const gcov_data = await run_gcov(path);
		for (const file_data of gcov_data.files) {
			if (file_data.file in lines_by_file) {
				lines_by_file[file_data.file].push(...file_data.lines);
			}
			else {
				lines_by_file[file_data.file] = file_data.lines;
			}
		}
	}
}

async function delete_coverage_data() {
	let paths = [];
	// Get all paths before starting to delete.
	for await (const path of get_gcda_paths()) {
		paths.push(path);
	}
	for (const path of paths) {
		fs.unlinkSync(path);
	}
}


async function show_decorations() {
	const editor = vscode.window.activeTextEditor;
	if (editor === undefined) {
		return;
	}

	const path = editor.document.uri.fsPath;
	if (!(path in lines_by_file)) {
		vscode.window.showInformationMessage("Cannot find coverage data for this file.");
		return;
	}


	let hit_lines: Map<number, [LineData]> = new Map();

	for (const line_data of lines_by_file[path]) {
		if (line_data.count > 0) {
			const key = line_data.line_number;
			let data = hit_lines.get(key);
			if (data === undefined) {
				hit_lines.set(key, [line_data]);
			}
			else {
				data.push(line_data);
			}
		}
	}

	let decorations: vscode.DecorationOptions[] = [];
	for (const [line_number, line_data_array] of hit_lines) {
		const line_index = line_number - 1;
		const range = new vscode.Range(
			new vscode.Position(line_index, 0),
			new vscode.Position(line_index, 100000));
		let count = 0;
		for (const line_data of line_data_array) {
			count += line_data.count;
		}
		const decoration: vscode.DecorationOptions = {
			range: range,
			renderOptions: {
				after: {
					contentText: count.toString(),
				},
			},
		};
		decorations.push(decoration);
	}
	editor.setDecorations(decorationType, decorations);
}
