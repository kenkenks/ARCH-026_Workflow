'use strict';
const { HelloWorld } = require('../../dist/src/hello/core');
const { RepositoryError } = require('../../dist/src/hello/contracts');
const { openMemory } = require('../adapters/hello/memory.cjs');
const { openLocalFile } = require('../adapters/hello/local-file.cjs');
const capability = name => Object.freeze({ name, version: 1 });
const base = Object.freeze(['repository.atomic-create', 'repository.revision-write'].map(capability));
const providers = Object.freeze({
  memory: Object.freeze({ offers: base, open: async () => openMemory() }),
  'local-file': Object.freeze({ offers: Object.freeze([...base, capability('storage.restart-persistence')]), open: options => openLocalFile(options.directory) }),
});
async function createHello({ provider, directory, required = [] }) {
  const selected = Object.hasOwn(providers, provider) ? providers[provider] : null;
  if (!selected || !Array.isArray(required) || [...base, ...required].some(request =>
      !request || !selected.offers.some(offer => offer.name === request.name && offer.version === request.version)) ||
      (provider === 'local-file' && (typeof directory !== 'string' || !directory)))
    throw new RepositoryError('UNSUPPORTED_CONFIGURATION');
  const handle = await selected.open({ directory });
  return { core: new HelloWorld(handle.port), repository: handle.port, close: () => handle.close() };
}
module.exports = { createHello, providers };
