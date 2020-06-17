import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as recursive_readdir from "recursive-readdir";
import { report } from 'process';

export function activate(context: vscode.ExtensionContext) {
	let command = vscode.commands.registerCommand("gcov-viewer.show", show_decorations);
	context.subscriptions.push(command);
}

export function deactivate() { }

const decorationType = vscode.window.createTextEditorDecorationType({
	backgroundColor: 'rgba(50, 240, 50, 0.2)',
	isWholeLine: true,
	cursor: "crosshair"
});

let lines_by_file = {};

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
		lines: [{
			count: number,
			function_name: string,
			line_number: number,
			unexecuted_block: boolean,
		}],
	}],
	current_working_directory: string,
	data_file: string,
};

async function run_gcov(path: string) {
	const command = `gcov --stdout --json-format "${path}"`;
	return new Promise<GcovJson>((resolve, reject) => {
		child_process.exec(command, {}, (err, stdout, stderr) => {
			let gcov_output = stdout.toString();
			let gcov_data = JSON.parse(gcov_output);
			resolve(gcov_data);
		});
	});
}

async function analyze_gcov_output() {
	lines_by_file = {};
	const base_path = "/home/jacques/blender-git/build_linux/";
	recursive_readdir(base_path, (err, files) => {
		for (const report_path of files) {
			if (report_path.endsWith(".gcda")) {
				console.log(report_path);
			}
		}
	});
}


async function show_decorations() {
	// analyze_gcov_output();
	const path = "/home/jacques/blender-git/build_linux/tests/gtests/blenlib/CMakeFiles/BLI_map_test.dir/BLI_map_test.cc.gcda";
	let gcov_data = await run_gcov(path);
	for (const file_data of gcov_data.files) {
		const source_file: string = file_data.file;
		if (source_file.endsWith("BLI_map_test.cc")) {
			let decorations: vscode.DecorationOptions[] = [];
			for (const line_data of file_data.lines) {
				const line_number = line_data.line_number - 1;
				let range = new vscode.Range(new vscode.Position(line_number, 0), new vscode.Position(line_number, 10000));
				let decoration: vscode.DecorationOptions = {
					range: range,
				};
				decorations.push(decoration);
			}
			const editor = vscode.window.activeTextEditor;
			editor?.setDecorations(decorationType, decorations);
		}
	}
}
