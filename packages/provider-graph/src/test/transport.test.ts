/**
 * Choosing a transport, and letting go of it afterwards.
 *
 * Both halves have bitten. Picking `https` when a mount meant `mcp` produces a device-code
 * prompt in a tenant that forbids one — an unskippable dead end rather than an
 * inconvenience. And failing to release the server leaves a subprocess holding an open
 * pipe, which keeps the event loop alive: the command prints its answer and then hangs
 * forever, which is exactly how this was found.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NULL_LOGGER } from '@mscomms/core';
import { getMcpTransport, releaseClient, resolveTransport } from '../shared.js';

/** A command that is certainly absent, so `auto` has to fall back. */
const MISSING = 'mscomms-definitely-not-a-real-command';

describe('resolveTransport', () => {
  it('honours an explicit https', () => {
    assert.equal(resolveTransport({ transport: 'https' }), 'https');
  });

  it('honours an explicit mcp even when the command is missing', () => {
    // Asking for it and not having it should fail loudly at the call, not silently turn
    // into the interactive sign-in the user was trying to avoid.
    assert.equal(resolveTransport({ transport: 'mcp', mcp: { command: MISSING } }), 'mcp');
  });

  it('falls back to https when auto finds no command', () => {
    assert.equal(resolveTransport({ transport: 'auto', mcp: { command: MISSING } }), 'https');
  });

  it('prefers mcp when auto finds the command', () => {
    assert.equal(resolveTransport({ mcp: { command: process.execPath } }), 'mcp');
  });

  it('defaults to auto when nothing is said', () => {
    // Whichever way this machine resolves, it must be one of the two real transports.
    assert.ok(['mcp', 'https'].includes(resolveTransport()));
  });
});

describe('transport sharing', () => {
  const options = { transport: 'mcp' as const, mcp: { command: process.execPath, args: ['-e', ''] } };

  it('hands every mount the same server', () => {
    // Three Graph mounts starting three copies of the same server would mean three startups
    // to answer questions one can serve.
    const first = getMcpTransport(options, NULL_LOGGER);
    const second = getMcpTransport(options, NULL_LOGGER);
    try {
      assert.equal(first, second);
    } finally {
      releaseClient(options);
      releaseClient(options);
    }
  });

  it('keeps the server while another mount is still using it', () => {
    const first = getMcpTransport(options, NULL_LOGGER);
    getMcpTransport(options, NULL_LOGGER);
    releaseClient(options);

    const stillThere = getMcpTransport(options, NULL_LOGGER);
    try {
      assert.equal(stillThere, first);
    } finally {
      releaseClient(options);
      releaseClient(options);
    }
  });

  it('starts a fresh server once the last user lets go', () => {
    const first = getMcpTransport(options, NULL_LOGGER);
    releaseClient(options);

    const second = getMcpTransport(options, NULL_LOGGER);
    try {
      assert.notEqual(second, first);
    } finally {
      releaseClient(options);
    }
  });

  it('gives different commands different servers', () => {
    const other = { transport: 'mcp' as const, mcp: { command: process.execPath, args: ['-e', '0'] } };
    const first = getMcpTransport(options, NULL_LOGGER);
    const second = getMcpTransport(other, NULL_LOGGER);
    try {
      assert.notEqual(first, second);
    } finally {
      releaseClient(options);
      releaseClient(other);
    }
  });

  it('ignores a release from a mount that never took one', () => {
    // The https transport has nothing to give back, and dispose runs for every mount.
    assert.doesNotThrow(() => releaseClient({ transport: 'https' }));
    assert.doesNotThrow(() => releaseClient(options));
  });
});
