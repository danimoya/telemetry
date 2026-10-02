import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './server.js';

test('startup awaits schema, salt, and listen in order', async () => {
  const events = [];

  await startServer({
    ensureSchemaFn: async () => {
      events.push('schema');
    },
    loadSaltFn: async () => {
      events.push('salt');
      return 'test-salt';
    },
    listenFn: async () => {
      events.push('listen');
      return 'http://127.0.0.1:4080';
    },
  });

  assert.deepEqual(events, ['schema', 'salt', 'listen']);
});

test('startup propagates schema failure without loading salt or listening', async () => {
  const events = [];
  const failure = new Error('schema unavailable');

  await assert.rejects(
    startServer({
      ensureSchemaFn: async () => {
        events.push('schema');
        throw failure;
      },
      loadSaltFn: async () => {
        events.push('salt');
        return 'test-salt';
      },
      listenFn: async () => {
        events.push('listen');
      },
    }),
    (err) => err === failure,
  );

  assert.deepEqual(events, ['schema']);
});

test('startup propagates salt failure without listening', async () => {
  const events = [];
  const failure = new Error('salt unavailable');

  await assert.rejects(
    startServer({
      ensureSchemaFn: async () => {
        events.push('schema');
      },
      loadSaltFn: async () => {
        events.push('salt');
        throw failure;
      },
      listenFn: async () => {
        events.push('listen');
      },
    }),
    (err) => err === failure,
  );

  assert.deepEqual(events, ['schema', 'salt']);
});

test('startup propagates listen failure after bootstrap completes', async () => {
  const events = [];
  const failure = new Error('port unavailable');

  await assert.rejects(
    startServer({
      ensureSchemaFn: async () => {
        events.push('schema');
      },
      loadSaltFn: async () => {
        events.push('salt');
        return 'test-salt';
      },
      listenFn: async () => {
        events.push('listen');
        throw failure;
      },
    }),
    (err) => err === failure,
  );

  assert.deepEqual(events, ['schema', 'salt', 'listen']);
});
