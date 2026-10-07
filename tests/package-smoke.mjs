import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const root = resolve(import.meta.dirname, '..');
const distJs = resolve(root, 'dist/mention.min.js');
const distCss = resolve(root, 'dist/mention.min.css');
const distTypes = resolve(root, 'dist/mention.d.ts');

await Promise.all([
    access(distJs),
    access(distCss),
    access(distTypes),
]);

const require = createRequire(import.meta.url);
const commonJs = require(distJs);
assert(
    typeof commonJs === 'function',
    'CommonJS package entry must export MentionJS constructor'
);

const esmNamespace = await import(pathToFileURL(distJs).href);
assert(
    typeof esmNamespace.default === 'function',
    'ES module default import must resolve the CommonJS MentionJS constructor'
);
assert(
    esmNamespace.default === commonJs,
    'CommonJS and ES default imports must resolve the same constructor'
);

console.log('MentionJS package consumer smoke tests passed');
