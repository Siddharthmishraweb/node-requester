import { mkdir, readFile, writeFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const exportedNames = Array.from(source.matchAll(/^export function ([a-zA-Z0-9_$]+)/gm), (m) => m[1]);
const constExports = Array.from(source.matchAll(/^export const ([a-zA-Z0-9_$]+)/gm), (m) => m[1]);
const classExports = Array.from(source.matchAll(/^export class ([a-zA-Z0-9_$]+)/gm), (m) => m[1]);
const names = [...exportedNames, ...constExports, ...classExports];

let cjs = source
  .replace("import { AsyncLocalStorage } from 'node:async_hooks';", "const { AsyncLocalStorage } = require('node:async_hooks');")
  .replace("import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';", "const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');")
  .replace("import { performance } from 'node:perf_hooks';", "const { performance } = require('node:perf_hooks');")
  .replace(/^export function /gm, 'function ')
  .replace(/^export class /gm, 'class ')
  .replace(/^export const /gm, 'const ');

cjs += `\n\nmodule.exports = { ${names.join(', ')} };\n`;

await mkdir(new URL('../dist', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/index.cjs', import.meta.url), cjs);
