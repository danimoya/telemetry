import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWeeklySalt } from './persisted-salt.js';

async function withDir(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-salt-test-'));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('new salt is persisted privately with its week and reused on later loads', () =>
  withDir(async (directory) => {
    const filename = join(directory, 'salt');
    const first = await createWeeklySalt(filename).forWeek('2026-40');
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal((await readFile(filename, 'utf8')).trim(), `2026-40 ${first}`);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
  }));

test('a restart in the same week keeps the salt (no double count)', () =>
  withDir(async (directory) => {
    const filename = join(directory, 'salt');
    const before = await createWeeklySalt(filename).forWeek('2026-40');
    // A new instance = a receiver restart.
    const after = await createWeeklySalt(filename).forWeek('2026-40');
    assert.equal(after, before);
  }));

test('a new week gets a new salt and the old one is gone from the file', () =>
  withDir(async (directory) => {
    const filename = join(directory, 'salt');
    const salts = createWeeklySalt(filename);
    const week40 = await salts.forWeek('2026-40');
    const week41 = await salts.forWeek('2026-41');
    assert.notEqual(week41, week40);
    const text = await readFile(filename, 'utf8');
    assert.equal(text.trim(), `2026-41 ${week41}`);
    assert.ok(!text.includes(week40));
    // A restart after the rotation keeps the new week's salt.
    assert.equal(await createWeeklySalt(filename).forWeek('2026-41'), week41);
    // No temporary files are left behind.
    assert.deepEqual(await readdir(directory), ['salt']);
  }));

test('a stale file from an earlier week is replaced at startup', () =>
  withDir(async (directory) => {
    const filename = join(directory, 'salt');
    const old = 'a1'.repeat(32);
    await writeFile(filename, `2026-39 ${old}\n`, { mode: 0o600 });
    const salt = await createWeeklySalt(filename).forWeek('2026-40');
    assert.notEqual(salt, old);
  }));

test('an existing valid salt for the week is preserved', () =>
  withDir(async (directory) => {
    const filename = join(directory, 'salt');
    const fixture = 'b2'.repeat(32);
    await writeFile(filename, `2026-40 ${fixture}\n`, { mode: 0o600 });
    assert.equal(await createWeeklySalt(filename).forWeek('2026-40'), fixture);
  }));

test('concurrent first pings of a week share one salt', () =>
  withDir(async (directory) => {
    const filename = join(directory, 'salt');
    const salts = createWeeklySalt(filename);
    const results = await Promise.all(Array.from({ length: 20 }, () => salts.forWeek('2026-40')));
    assert.equal(new Set(results).size, 1);
    assert.equal((await readFile(filename, 'utf8')).trim(), `2026-40 ${results[0]}`);
  }));

test('malformed existing file is not silently replaced', () =>
  withDir(async (directory) => {
    const filename = join(directory, 'salt');
    for (const bad of ['invalid', 'a1'.repeat(32), `2026-40 ${'zz'.repeat(32)}`]) {
      await writeFile(filename, bad);
      await assert.rejects(createWeeklySalt(filename).forWeek('2026-40'), /YYYY-WW/);
      assert.equal(await readFile(filename, 'utf8'), bad);
    }
  }));

test('a failure does not poison later calls', () =>
  withDir(async (directory) => {
    const filename = join(directory, 'salt');
    const salts = createWeeklySalt(filename);
    await assert.rejects(salts.forWeek('not-a-week'), /invalid week bucket/);
    assert.match(await salts.forWeek('2026-40'), /^[0-9a-f]{64}$/);
  }));

test('missing parent directory fails instead of using volatile state', () =>
  withDir(async (directory) => {
    await assert.rejects(createWeeklySalt(join(directory, 'missing', 'salt')).forWeek('2026-40'), {
      code: 'ENOENT',
    });
  }));
