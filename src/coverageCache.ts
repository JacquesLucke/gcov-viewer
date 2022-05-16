import { loadGcovData, GcovFileData } from './gcovInterface';
import { resolve } from 'path';
/**
 * Cache for all data loaded using gcov. This way we don't have to reload
 * it everytime the user looks at a new file.
 */
export class CoverageCache {
    dataByFile: Map<string, GcovFileData> = new Map();
    demangledNames: Map<string, string> = new Map();
    loadedGcdaFiles: string[] = [];

    async loadGcdaFiles(buildDirectory: string, gcdaPaths: string[]) {
        const gcovDataArray = await loadGcovData(buildDirectory, gcdaPaths);

        for (const gcovData of gcovDataArray) {
            for (const fileData of gcovData.files) {
                const cachedFileData = this.dataByFile.get(fileData.file);
                if (cachedFileData === undefined) {
                    let realpath = fileData.file;
                    if (!realpath.startsWith("/")) { /* relative path to absolute path */
                        realpath = resolve(buildDirectory, realpath)
                    }

                    this.dataByFile.set(realpath, {
                        file: realpath,
                        lines: [...fileData.lines],
                        functions: [...fileData.functions],
                    });
                }
                else {
                    cachedFileData.lines.push(...fileData.lines);
                    cachedFileData.functions.push(...fileData.functions);
                }

                for (const functionData of fileData.functions) {
                    this.demangledNames.set(functionData.name, functionData.demangled_name);
                }
            }
        }
        this.loadedGcdaFiles.push(...gcdaPaths);
    }

    hasData() {
        return this.loadedGcdaFiles.length > 0;
    }
};
