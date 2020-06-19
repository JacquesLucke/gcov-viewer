export interface LineData {
    count: number,
    function_name: string,
    line_number: number,
    unexecuted_block: boolean,
};

export interface FunctionData {
    blocks: number,
    blocks_executed: number,
    demangled_name: string,
    start_column: number,
    start_line: number,
    end_column: number,
    end_line: number,
    execution_count: number,
    name: string,
};

export interface GcovData {
    files: [{
        file: string,
        functions: FunctionData[],
        lines: LineData[],
    }],
    current_working_directory: string,
    data_file: string,
};
