export function shuffleArray(a: any[]) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

export function splitArrayInChunks(array: any[], chunkAmount: number) {
    const chunkSize = Math.ceil(array.length / chunkAmount);
    const chunks = [];
    for (let i = 0; i < chunkAmount; i++) {
        chunks.push(array.slice(i * chunkSize, (i + 1) * chunkSize));
    }
    return chunks;
}
