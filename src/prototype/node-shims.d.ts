declare const process: { exitCode?: number };
declare module 'node:assert/strict' { const assert: any; export default assert; }
declare module 'node:test' { const test: (name: string, fn: () => void | Promise<void>) => void; export default test; }
