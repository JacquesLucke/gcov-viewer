import * as vscode from 'vscode';
import * as child_process from 'child_process';

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

async function show_decorations() {
	const path = "/home/jacques/blender-git/build_linux/tests/gtests/blenlib/CMakeFiles/BLI_map_test.dir/BLI_map_test.cc.gcda";
	const command = `gcov --stdout --json-format "${path}"`;
	child_process.exec(command, {}, (err, stdout, stderr) => {
		let gcov_output = stdout.toString();
		let gcov_data = JSON.parse(gcov_output);
		for (const file_data of gcov_data["files"]) {
			const source_file: String = file_data["file"];
			if (source_file.endsWith("BLI_map_test.cc")) {
				let decorations: vscode.DecorationOptions[] = [];
				for (const line_data of file_data["lines"]) {
					const line_number = line_data["line_number"] - 1;
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
	});
}
