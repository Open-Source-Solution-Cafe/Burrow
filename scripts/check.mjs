import { bin, run } from './lib.mjs';

if (process.argv.includes('--sqlite')) process.env.BURROW_TEST_SQLITE_ONLY = '1';

/** Local replacement for CI: typecheck, lint, API tests. Aborts on first failure. */
console.log('check: sync');
run('node', ['./scripts/check-sync.mjs']);

console.log('check: version');
run('node', ['./scripts/check-version.mjs']);

console.log('check: typecheck');
run(bin('typescript', 'tsc'), ['-b']);

console.log('check: basalt');
run('./scripts/check-basalt.mjs', []);

console.log('check: licenses');
run('node', ['./scripts/check-licenses.mjs']);

console.log('check: decoupling');
run('node', ['./scripts/check-decoupling.mjs']);

console.log('check: lint');
run(bin('eslint'), ['--max-warnings=0', '.']);

console.log('check: tests');
run(bin('vitest'), ['run']);

console.log('check: OK');
