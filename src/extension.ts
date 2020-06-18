import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as recursive_readdir from 'recursive-readdir';

let is_showing_decorations: boolean = false;

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand('gcov-viewer.show', show_decorations));
	context.subscriptions.push(vscode.commands.registerCommand('gcov-viewer.hide', hide_decorations));
	context.subscriptions.push(vscode.commands.registerCommand('gcov-viewer.toggle', toggle_decorations));
	context.subscriptions.push(vscode.commands.registerCommand('gcov-viewer.reload_coverage_data', reload_coverage_data));
	context.subscriptions.push(vscode.commands.registerCommand('gcov-viewer.delete_coverage_data', delete_coverage_data));
	vscode.window.onDidChangeVisibleTextEditors(async editors => {
		if (is_showing_decorations) {
			await show_decorations();
		}
	});
}

export function deactivate() { }

const decorationType = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
	overviewRulerColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
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
		functions: {
			blocks: number,
			blocks_executed: number,
			demangled_name: string,
			start_column: number,
			start_line: number,
			end_column: number,
			end_line: number,
			execution_count: number,
			name: string,
		}[],
		lines: LineData[],
	}],
	current_working_directory: string,
	data_file: string,
};

async function run_gcov(paths: string[]) {
	if (paths.length === 0) {
		return [];
	}

	const config = vscode.workspace.getConfiguration('gcov_viewer', null);
	const gcov_binary = config.get<string>('gcov_binary');

	let command = `${gcov_binary} --stdout --json-format`;
	for (const path of paths) {
		command += ` "${path}"`;
	}
	return new Promise<GcovJson[]>((resolve, reject) => {
		child_process.exec(command, { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				console.error(`exec error: ${err}`);
				reject();
				return;
			}
			const gcov_output = stdout.toString();
			let output = [];
			const parts = gcov_output.split('\n');
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

async function get_gcda_paths() {
	if (vscode.workspace.workspaceFolders === undefined) {
		return [];
	}

	let include_directories: string[] = [];
	let workspace_folder_paths: string[] = [];
	for (let workspace_folder of vscode.workspace.workspaceFolders) {
		workspace_folder_paths.push(workspace_folder.uri.fsPath);
		const config = vscode.workspace.getConfiguration('gcov_viewer', workspace_folder);
		const dirs = config.get<string[]>('include_directories');
		if (dirs !== undefined) {
			for (let dir of dirs) {
				dir = dir.replace('${workspaceFolder}', workspace_folder.uri.fsPath);
				include_directories.push(dir);
			}
		}
	}

	if (include_directories.length === 0) {
		include_directories.push(...workspace_folder_paths);
	}

	let gcda_paths: Set<string> = new Set();
	for (const base_path of include_directories) {
		const all_paths = await recursive_readdir(base_path);
		for (const path of all_paths) {
			if (path.endsWith('.gcda')) {
				gcda_paths.add(path);
			}
		}
	}

	return Array.from(gcda_paths);
}

function reset_loaded_coverage_data() {
	lines_by_file = new Map();
	demangled_names = new Map();
	loaded_gcda_files = [];
}

let lines_by_file: Map<string, LineData[]>;
let demangled_names: Map<string, string>;
let loaded_gcda_files: string[];
reset_loaded_coverage_data();



async function reload_coverage_data_from_paths(
	paths: string[], total_paths: number,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	cancellation_token: vscode.CancellationToken) {

	if (paths.length > 30) {
		const middle = Math.floor(paths.length / 2);
		await reload_coverage_data_from_paths(paths.slice(0, middle), total_paths, progress, cancellation_token);
		await reload_coverage_data_from_paths(paths.slice(middle, paths.length), total_paths, progress, cancellation_token);
		return;
	}

	progress.report({ increment: 100 * paths.length / total_paths, message: `[${loaded_gcda_files.length}/${total_paths}]` });
	const gcov_data_array = await run_gcov(paths);
	for (const gcov_data of gcov_data_array) {
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
	loaded_gcda_files.push(...paths);
}

function shuffle_array(a: any[]) {
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

async function reload_coverage_data() {
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			cancellable: true,
			title: 'Reload Coverage Data',
		},
		async (progress, cancellation_token) => {
			reset_loaded_coverage_data();
			progress.report({ increment: 0, message: 'Searching .gcda files' });

			let gcda_paths = await get_gcda_paths();
			shuffle_array(gcda_paths);
			const async_amount = 20;
			const chunk_size = gcda_paths.length / async_amount;

			let promises = [];
			for (let i = 0; i < async_amount; i++) {
				promises.push(reload_coverage_data_from_paths(
					gcda_paths.slice(i * chunk_size, (i + 1) * chunk_size), gcda_paths.length, progress, cancellation_token));
			}
			await Promise.all(promises);
		}
	);


}

async function delete_coverage_data() {
	reset_loaded_coverage_data();
	await hide_decorations();

	for (const path of await get_gcda_paths()) {
		fs.unlinkSync(path);
	}

}

async function toggle_decorations() {
	if (is_showing_decorations) {
		await hide_decorations();
	}
	else {
		await show_decorations();
	}
}

async function hide_decorations() {
	for (const editor of vscode.window.visibleTextEditors) {
		editor.setDecorations(decorationType, []);
	}
	is_showing_decorations = false;
}

async function show_decorations() {
	let found_decorations = false;
	for (const editor of vscode.window.visibleTextEditors) {
		found_decorations = found_decorations || await decorateEditor(editor);
	}
	if (found_decorations) {
		is_showing_decorations = true;
	}
}

function get_lines_data_for_file(absolute_path: string) {
	const lines_data_of_file = lines_by_file.get(absolute_path);
	if (lines_data_of_file !== undefined) {
		return lines_data_of_file;
	}
	for (const [stored_path, lines_data] of lines_by_file.entries()) {
		if (absolute_path.endsWith(stored_path)) {
			return lines_data;
		}
	}
	return undefined;
}

async function decorateEditor(editor: vscode.TextEditor) {
	if (lines_by_file.size === 0) {
		await reload_coverage_data();
	}

	const path = editor.document.uri.fsPath;
	const lines_data_of_file = get_lines_data_for_file(path);
	if (lines_data_of_file === undefined) {
		return false;
	}

	let hit_lines: Map<number, LineData[]> = new Map();

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
		let line_data_by_function: Map<string, LineData[]> = new Map();
		for (const line_data of line_data_array) {
			total_count += line_data.count;
			let data = line_data_by_function.get(line_data.function_name);
			if (data === undefined) {
				line_data_by_function.set(line_data.function_name, [line_data]);
			}
			else {
				data.push(line_data);
			}
		}

		let tooltip = '';
		for (const [function_name, data_array] of line_data_by_function.entries()) {
			let count = 0;
			for (const line_data of data_array) {
				count += line_data.count;
			}
			const demangled_name = demangled_names.get(function_name)!;
			tooltip += `${count.toLocaleString()}x in \`${demangled_name}\`\n\n`;
		}
		const decoration: vscode.DecorationOptions = {
			range: range,
			hoverMessage: tooltip,
			renderOptions: {
				after: {
					contentText: `   ${total_count.toLocaleString()}x`,
					color: new vscode.ThemeColor('editorCodeLens.foreground'),
					fontStyle: 'italic',
				},
			},
		};
		decorations.push(decoration);
	}
	editor.setDecorations(decorationType, decorations);

	return decorations.length > 0;
}
