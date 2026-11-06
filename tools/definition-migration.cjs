'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {planDefinitionMigration, executeDefinitionMigration} = require('../dist/src/migration/definition');

async function main() {
  const [mode, bindingFile, inputFile, ...extra] = process.argv.slice(2);
  if (!['dry-run', 'apply'].includes(mode) || !bindingFile || !inputFile || extra.length)
    throw Error('INVALID_ARGUMENT');
  const input = JSON.parse(fs.readFileSync(path.resolve(inputFile), 'utf8'));
  // Explicit trusted local code: storage paths, factories and close belong to Composition.
  const open = require(path.resolve(bindingFile));
  const binding = await open();
  let result, primary;
  try {
    result = mode === 'dry-run'
      ? await planDefinitionMigration(input, binding.source, binding.destination, binding.registry)
      : await executeDefinitionMigration(input, binding.source, binding.destination, binding.registry);
  } catch (error) { primary = error; }
  try { await binding.close(); } catch {
    if (primary) primary.cleanupDiagnostics = ['COMPOSITION_CLOSE_FAILED'];
    else { result = {ok: false, operationResult: result, cleanupDiagnostics: ['COMPOSITION_CLOSE_FAILED']}; }
  }
  if (primary) throw primary;
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.ok === false || (mode === 'dry-run' && result.items?.some(item => ['CONFLICT', 'REJECT'].includes(item.action)))) process.exitCode = 2;
}
main().catch(() => {
  // Do not print exception text, paths, stack, credentials or arbitrary adapter codes.
  process.stderr.write('DEFINITION_MIGRATION_FAILED\n'); process.exitCode = 1;
});
