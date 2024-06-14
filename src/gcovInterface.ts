import * as vscode from "vscode";
import * as child_process from "child_process";

export interface GcovLineData {
  count: number;
  function_name: string;
  line_number: number;
  unexecuted_block: boolean;
}

export interface GcovFunctionData {
  blocks: number;
  blocks_executed: number;
  demangled_name: string;
  start_column: number;
  start_line: number;
  end_column: number;
  end_line: number;
  execution_count: number;
  name: string;
}

export interface GcovFileData {
  file: string;
  lines: GcovLineData[];
  functions: GcovFunctionData[];
}

export interface GcovData {
  files: GcovFileData[];
  current_working_directory: string;
  data_file: string;
}

function getGcovBinary() {
  const config = vscode.workspace.getConfiguration("gcovViewer", null);
  const gcovBinary = config.get<string>("gcovBinary");
  return gcovBinary;
}

export async function isGcovCompatible() {
  const gcovBinary = getGcovBinary();
  const command = `${gcovBinary} --help`;
  return new Promise<boolean>((resolve, reject) => {
    child_process.exec(command, (err, stdout, stderr) => {
      if (err) {
        vscode.window.showErrorMessage(
          `Error while trying to run gcov, try to change the "Gcov Binary" setting. ${err}`
        );
        resolve(false);
        return;
      }
      const gcovOutput = stdout.toString();
      const supportsRequiredArgs =
        gcovOutput.includes("--json-format") && gcovOutput.includes("--stdout");
      if (!supportsRequiredArgs) {
        vscode.window.showErrorMessage(
          `The gcov version is not compatible. Please use at least version 9.`
        );
      }
      resolve(supportsRequiredArgs);
    });
  });
}

export async function loadGcovData(paths: string[]): Promise<GcovData[]> {
  if (paths.length === 0) {
    return [];
  }

  const gcovBinary = getGcovBinary();

  let command = `${gcovBinary} --stdout --json-format`;
  for (const path of paths) {
    command += ` "${path}"`;
  }
  return new Promise<GcovData[]>((resolve, reject) => {
    child_process.exec(
      command,
      { maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          vscode.window.showErrorMessage(
            `Error invoking gcov: ${stderr.toString()}`
          );
          console.log(err);
          reject();
          return;
        }
        const gcovOutput = stdout.toString();
        const output = [];
        const parts = gcovOutput.split("\n");
        for (const part of parts) {
          if (part.length === 0) {
            continue;
          }
          output.push(JSON.parse(part));
        }
        resolve(output);
      }
    );
  });
}
