#!/usr/bin/env node
/**
 * Executable shim.
 *
 * Kept deliberately thin: everything testable lives in index.ts, which returns an exit
 * code rather than calling process.exit, so the whole CLI can be driven from a test.
 */

import { main } from './index.js';

const code = await main({ argv: process.argv.slice(2) });

// Let queued stdout writes flush before exiting; on Windows, process.exit can truncate
// output on a pipe.
process.exitCode = code;
