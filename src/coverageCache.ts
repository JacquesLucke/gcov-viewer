import { GcovLineData, GcovData } from './gcovInterface';
import { loadGcovData } from './gcovInterface';

export class CoverageCache {
    linesByFile: Map<string, GcovLineData[]> = new Map();
    demangledNames: Map<string, string> = new Map();
    loadedGcdaFiles: string[] = [];

    async loadGcdaFiles(gcdaPaths: string[]) {
        const gcovDataArray = await loadGcovData(gcdaPaths);

        for (const gcovData of gcovDataArray) {
            for (const fileData of gcovData.files) {
                const lineDataArray = this.linesByFile.get(fileData.file);
                if (lineDataArray === undefined) {
                    this.linesByFile.set(fileData.file, fileData.lines);
                }
                else {
                    lineDataArray.push(...fileData.lines);
                }

                for (const functionData of fileData.functions) {
                    this.demangledNames.set(functionData.name, functionData.demangled_name);
                }
            }
        }
        this.loadedGcdaFiles.push(...gcdaPaths);
    }
};
