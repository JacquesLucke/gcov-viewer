import * as vscode from 'vscode';

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

function show_decorations() {
	let decorationsArray: vscode.DecorationOptions[] = [];
	let range = new vscode.Range(new vscode.Position(3, 0), new vscode.Position(7, 2));
	let decoration: vscode.DecorationOptions = {
		range: range,
		hoverMessage: "**te**st",
		renderOptions: {
			after: {
				contentText: "Hello World",
			},
		}
	};
	decorationsArray.push(decoration);
	const editor = vscode.window.activeTextEditor;
	editor?.setDecorations(decorationType, decorationsArray);
}
