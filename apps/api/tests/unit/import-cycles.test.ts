import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sourceRoot = path.resolve(__dirname, '../../src');

// An import or re-export from a relative path, and the names it brings.
const RELATIVE_IMPORT = /^(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+'(\.{1,2}\/[^']+)'/gm;

// Whether the statement brings anything at run time: `import type …` and `{ type A, type B }` are erased.
const isRuntime = (typeKeyword: string | undefined, names: string): boolean => {
  if (typeKeyword) {
    return false;
  }
  const braced = names.match(/^\{([^}]*)\}$/s);
  return !braced || braced[1].split(',').some((name) => name.trim() !== '' && !name.trim().startsWith('type '));
};

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith('.ts') ? [full] : [];
  });

/** Each source file's run-time imports of other source files. */
const runtimeImportGraph = (files: Map<string, string>): Map<string, string[]> =>
  new Map(
    [...files].map(([file, text]) => [
      file,
      [...text.matchAll(RELATIVE_IMPORT)].filter(([, typeKeyword, names]) => isRuntime(typeKeyword, names)).map(([, , , target]) => path.resolve(path.dirname(file), target)),
    ])
  );

/** The groups of files that import one another in a ring (strongly connected components, Tarjan), each sorted. */
const cyclesOf = (graph: Map<string, string[]>): string[][] => {
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (file: string) => {
    index.set(file, index.size);
    lowLink.set(file, index.get(file)!);
    stack.push(file);
    for (const next of (graph.get(file) ?? []).filter((target) => graph.has(target))) {
      if (!index.has(next)) {
        visit(next);
        lowLink.set(file, Math.min(lowLink.get(file)!, lowLink.get(next)!));
      } else if (stack.includes(next)) {
        lowLink.set(file, Math.min(lowLink.get(file)!, index.get(next)!));
      }
    }
    if (lowLink.get(file) === index.get(file)) {
      const ring = stack.splice(stack.indexOf(file));
      if (ring.length > 1 || graph.get(file)!.includes(file)) {
        cycles.push(ring.sort());
      }
    }
  };
  for (const file of graph.keys()) {
    if (!index.has(file)) {
      visit(file);
    }
  }
  return cycles;
};

// Two modules that import each other's values can each find the other half loaded: a top-level use, such
// as loanSearch reading ITEM_IS_OUTSTANDING, then throws. loan-read and repair-read read each other's facts
// through loan-return-read.ts for this reason (#103).
describe('API source imports', () => {
  it('form no cycle at run time', () => {
    const files = new Map(sourceFiles(sourceRoot).map((file) => [file, fs.readFileSync(file, 'utf8')]));

    const cycles = cyclesOf(runtimeImportGraph(files)).map((cycle) => cycle.map((file) => path.relative(sourceRoot, file)).join(' -> '));

    expect(cycles).toEqual([]);
  });

  it('finds a cycle through a value import, and none through a type import', () => {
    const at = (name: string) => path.join(sourceRoot, name);
    const graphOf = (readImport: string) =>
      runtimeImportGraph(
        new Map([
          [at('a.ts'), "import { b } from './b.ts';\n"],
          [at('b.ts'), `${readImport}\n`],
        ])
      );

    expect(cyclesOf(graphOf("import { a, type A } from './a.ts';"))).toEqual([[at('a.ts'), at('b.ts')]]);
    expect(cyclesOf(graphOf("import type { A } from './a.ts';"))).toEqual([]);
    expect(cyclesOf(graphOf("import { type A } from './a.ts';"))).toEqual([]);
  });
});
