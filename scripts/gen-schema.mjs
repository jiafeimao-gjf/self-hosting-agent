#!/usr/bin/env node
/**
 * 由代码里的帧表生成 JSON Schema。
 *
 * SDD 的规矩：规格可以生成，但不可以和实现不一致。
 * 因此 specs/schemas/*.schema.json 是**生成物**，一致性由 test/protocol.test.ts 的 PROTO-007 守护。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { frameJsonSchema } from '../src/protocol/frames.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'specs', 'schemas');
fs.mkdirSync(outDir, { recursive: true });

const targets = [{ file: 'frame.schema.json', schema: frameJsonSchema() }];

for (const target of targets) {
  const outPath = path.join(outDir, target.file);
  const content = JSON.stringify(target.schema, null, 2) + '\n';
  fs.writeFileSync(outPath, content, 'utf8');
  const relative = path.relative(path.join(here, '..'), outPath);
  console.log(`generated ${relative} (${content.length} bytes)`);
}
