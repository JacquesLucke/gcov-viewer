import {
  loadGcovData,
  GcovFileData,
  GcovLineData,
  GcovFunctionData,
} from "./gcovInterface";

/**
 * Cache for all data loaded using gcov. This way we don't have to reload
 * it everytime the user looks at a new file.
 */
export class CoverageCache {
  dataByFile: Map<string, FileCoverage> = new Map();
  demangledNames: Map<string, string> = new Map();
  loadedGcdaFiles: string[] = [];

  async loadGcdaFiles(gcdaPaths: string[]) {
    const gcovDataArray = await loadGcovData(gcdaPaths);

    for (const gcovData of gcovDataArray) {
      for (const fileData of gcovData.files) {
        let fileCoverage = this.dataByFile.get(fileData.file);
        if (fileCoverage === undefined) {
          fileCoverage = new FileCoverage(fileData.file);
          this.dataByFile.set(fileData.file, fileCoverage);
        }

        fileCoverage.rawLines.push(...fileData.lines);
        fileCoverage.rawFunctions.push(...fileData.functions);

        for (const functionData of fileData.functions) {
          this.demangledNames.set(
            functionData.name,
            functionData.demangled_name
          );
        }
      }
    }
    this.loadedGcdaFiles.push(...gcdaPaths);
  }

  hasData() {
    return this.loadedGcdaFiles.length > 0;
  }
}

export class FileCoverage {
  path: string;
  rawLines: GcovLineData[] = [];
  rawFunctions: GcovFunctionData[] = [];

  calledLines?: number;
  totalLines?: number;
  maxLine?: number;
  dataByLine?: Map<number, LineCoverage>;
  functionsByStart?: Map<number, FunctionCoverage>;

  constructor(path: string) {
    this.path = path;
  }

  ensureAnalysed() {
    this.ensureFileCoverate();
    this.ensureLineCoverage();
    this.ensureFunctionCoverage();
  }

  ensureFileCoverate() {
    if (this.calledLines !== undefined) {
      return;
    }
    this.ensureLineCoverage();
    this.totalLines = this.dataByLine?.size;
    this.calledLines = 0;
    for (const lineCoverage of this.dataByLine!.values()) {
      if (lineCoverage.executionCount > 0) {
        this.calledLines++;
      }
    }
  }

  ensureLineCoverage() {
    if (this.dataByLine !== undefined) {
      return;
    }
    this.maxLine = -1;
    this.dataByLine = new Map();
    for (const rawLine of this.rawLines) {
      const line = rawLineToIndex(rawLine.line_number);
      let lineCoverage = this.dataByLine.get(line);
      if (lineCoverage === undefined) {
        lineCoverage = {
          line,
          raw: [],
          executionCount: 0,
        };
        this.dataByLine.set(line, lineCoverage);
      }
      lineCoverage.raw.push(rawLine);
      lineCoverage.executionCount += rawLine.count;
      if (line > this.maxLine) {
        this.maxLine = line;
      }
    }
  }

  ensureFunctionCoverage() {
    if (this.functionsByStart !== undefined) {
      return;
    }
    this.ensureLineCoverage();

    this.functionsByStart = new Map();
    for (const rawFunction of this.rawFunctions) {
      const startLine = rawLineToIndex(rawFunction.start_line);
      const endLine = rawLineToIndex(rawFunction.end_line);
      let functionCoverage = this.functionsByStart.get(startLine);
      if (functionCoverage === undefined) {
        functionCoverage = {
          startLine: startLine,
          endLine: endLine,
          baseName: extractCoreFunctionName(rawFunction.demangled_name),
          executionCount: 0,
          raw: [],
          calledLines: 0,
          totalLines: 0,
        };
        this.functionsByStart.set(startLine, functionCoverage);
      }
      functionCoverage.executionCount += rawFunction.execution_count;
      functionCoverage.raw.push(rawFunction);
    }
    for (const functionCoverage of this.functionsByStart.values()) {
      for (
        let line = functionCoverage.startLine;
        line <= functionCoverage.endLine;
        line++
      ) {
        const lineCoverage = this.dataByLine?.get(line);
        if (lineCoverage === undefined) {
          continue;
        }
        functionCoverage.totalLines++;
        if (lineCoverage.executionCount > 0) {
          functionCoverage.calledLines++;
        }
      }
    }
  }
}

export interface LineCoverage {
  line: number;
  raw: GcovLineData[];
  executionCount: number;
}

export interface FunctionCoverage {
  startLine: number;
  endLine: number;
  raw: GcovFunctionData[];
  baseName: string;
  executionCount: number;
  calledLines: number;
  totalLines: number;
}

function extractCoreFunctionName(demangledName: string) {
  /* Remove parts in parenthesis and templates. */
  let name = "";
  let templateDepth = 0;
  let parenthesisDepth = 0;
  let lastClosingParenthesis = 0;
  for (const c of demangledName) {
    if (c === "(") {
      parenthesisDepth++;
    } else if (c === ")") {
      parenthesisDepth--;
      if (parenthesisDepth === 0) {
        lastClosingParenthesis = name.length;
      }
    } else if (c == "<") {
      templateDepth++;
    } else if (c == ">") {
      templateDepth--;
      if (parenthesisDepth === 0 && templateDepth === 0) {
        name += "<...>";
      }
    } else if (parenthesisDepth === 0 && templateDepth == 0) {
      name += c;
    }
  }
  /* Remove possible stuff after the parameter list. */
  name = name.slice(0, lastClosingParenthesis);
  /* Remove return value. */
  name = name.split(" ").pop()!;
  /* Fix case for call operator. */
  if (name.endsWith("::operator")) {
    name += "()";
  }
  return name;
}

/** Lines in gcov start counting at 1. */
function rawLineToIndex(lineNumber: number) {
  return lineNumber - 1;
}
