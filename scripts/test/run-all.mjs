#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSelfTestCli } from './_self-test-runner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frameworkRoot = join(__dirname, '..', '..');
const exitCode = await runSelfTestCli(process.argv.slice(2), { frameworkRoot });
process.exit(exitCode);
