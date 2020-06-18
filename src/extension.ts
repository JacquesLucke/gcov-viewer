import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as recursive_readdir from 'recursive-readdir';
import { versions } from 'process';

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand('gcov-viewer.show', show_decorations));
	context.subscriptions.push(vscode.commands.registerCommand('gcov-viewer.load_coverage_data', load_coverage_data));
	context.subscriptions.push(vscode.commands.registerCommand('gcov-viewer.delete_coverage_data', delete_coverage_data));
}

export function deactivate() { }

const decorationType = vscode.window.createTextEditorDecorationType({
	backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
	isWholeLine: true,
});

interface LineData {
	count: number,
	function_name: string,
	line_number: number,
	unexecuted_block: boolean,
};

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
	const command = `gcov --stdout --json-format '${path}'`;
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

async function get_gcda_paths() {
	const base_path = '/home/jacques/blender-git/build_linux/';
	const all_paths = await recursive_readdir(base_path);
	const gcda_paths = all_paths.filter(value => value.endsWith('.gcda'));
	return gcda_paths;
}

let lines_by_file: Map<string, [LineData]> = new Map();
let demangled_names: Map<string, string> = new Map();

async function load_coverage_data() {
	vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			cancellable: true,
			title: 'Load Covarage Data',
		},
		async (progress, cancellation_token) => {
			lines_by_file = new Map();
			demangled_names = new Map();
			progress.report({ increment: 0, message: 'Searching .gcda files' });

			const gcda_paths = await get_gcda_paths();
			const increment = 100.0 / gcda_paths.length;

			for (const [index, path] of gcda_paths.entries()) {
				if (cancellation_token.isCancellationRequested) {
					return;
				}

				progress.report({ increment: increment, message: `[${index + 1}/${gcda_paths.length}] ${path}` });
				const gcov_data = await run_gcov(path);
				for (const file_data of gcov_data.files) {
					let line_data_array = lines_by_file.get(file_data.file);
					if (line_data_array === undefined) {
						lines_by_file.set(file_data.file, file_data.lines);
					}
					else {
						line_data_array.push(...file_data.lines);
					}

					for (const function_data of file_data.functions) {
						demangled_names.set(function_data.name, function_data.demangled_name);
					}
				}
			}
		}
	);


}

async function delete_coverage_data() {
	for (const path of await get_gcda_paths()) {
		fs.unlinkSync(path);
	}
}


async function show_decorations() {
	const editor = vscode.window.activeTextEditor;
	if (editor === undefined) {
		return;
	}

	const path = editor.document.uri.fsPath;
	const lines_data_of_file = lines_by_file.get(path);
	if (lines_data_of_file === undefined) {
		vscode.window.showInformationMessage('Cannot find coverage data for this file.');
		return;
	}


	let hit_lines: Map<number, [LineData]> = new Map();

	for (const line_data of lines_data_of_file) {
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
		let total_count = 0;
		let tooltip = '';
		for (const line_data of line_data_array) {
			const count = line_data.count;
			total_count += count;
			const demangled_name = demangled_names.get(line_data.function_name)!;
			tooltip += `${count} ${(count === 1) ? 'Call' : 'Calls'} in  \`${demangled_name}\`\n\n`;
		}
		const decoration: vscode.DecorationOptions = {
			range: range,
			hoverMessage: tooltip,
			renderOptions: {
				after: {
					contentText: '  Count: ' + total_count.toString(),
					color: new vscode.ThemeColor('editorCodeLens.foreground'),
					fontStyle: 'italic',
				},
			},
		};
		decorations.push(decoration);
	}
	editor.setDecorations(decorationType, decorations);
}
