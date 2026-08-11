/**
 * Test helpers, exported so provider authors outside this repo can use them.
 *
 * Kept in a subpath (`@mscomms/core/testing`) rather than the main entry point so that
 * nothing here ends up in the runtime dependency graph of the shell.
 */

export { conformanceTests, type ConformanceCase, type ConformanceOptions } from './conformance.js';
