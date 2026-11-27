#!/usr/bin/env node
/**
 * tests/code-review/ocr-spawn.test.mjs
 *
 * Regression check for the Windows npm shim.
 *
 * On Windows `npm i -g @alibaba-group/open-code-review` installs `ocr.cmd`
 * (plus an extension-less POSIX shim). `spawn`/`execFile` hand the path to
 * CreateProcess, which only accepts PE images, so a `.cmd` path fails with
 * EINVAL. The adapter must route shims through `cmd.exe` instead of reporting
 * "未找到 ocr CLI".
 *
 * The scenario is Windows-only; other platforms exit 0 without touching disk.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probe } from '../../host/ocr.js';

if (process.platform !== 'win32') {
  console.log('skip: .cmd shim scenario is Windows-only');
  process.exit(0);
}

const dir = await mkdtemp(join(tmpdir(), 'ocr shim '));
try {
  const shim = join(dir, 'ocr.cmd');
  await writeFile(
    shim,
    '@echo off\r\necho open-code-review v9.9.9 (deadbee) windows/amd64\r\n',
    'utf8',
  );

  const result = await probe({ config: { ocr: { command: shim } } });
  assert.equal(result.available, true, `probe reported unavailable: ${result.error}`);
  assert.equal(result.version, 'v9.9.9', `unexpected version: ${result.version}`);
  assert.equal(result.path, shim);
  console.log('ok: .cmd shim executes through cmd.exe');

  // `where ocr` lists the extension-less POSIX shim first, so a user copying an
  // absolute path out of it hands us the one file Windows cannot run.
  const posixShim = join(dir, 'ocr');
  await writeFile(posixShim, '#!/bin/sh\nexit 0\n', 'utf8');
  const viaShim = await probe({ config: { ocr: { command: posixShim } } });
  assert.equal(viaShim.available, true, `extension-less shim not upgraded: ${viaShim.error}`);
  assert.equal(viaShim.path, shim, `expected the .cmd sibling, got ${viaShim.path}`);
  console.log('ok: extension-less shim is upgraded to its .cmd sibling');
} finally {
  await rm(dir, { recursive: true, force: true });
}
