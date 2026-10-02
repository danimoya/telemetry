// Weekly hashing salt, persisted so a receiver restart in the middle of a week keeps the same salt
// (otherwise every installation that pings again after the restart gets a new hash and is counted
// twice that week).
//
// File format (one line, mode 0600):  <YYYY-WW> <64 hex characters>
//
// The salt belongs to one ISO week. The first ping of a new week replaces the file with a fresh
// random salt for that week, so last week's salt is gone and hashes from different weeks cannot be
// linked, which is the rotation salt-rotate.cron used to do. Replacement is atomic: write a temporary
// file in the same directory, then rename it over the old one.
//
// Fail closed: a missing directory or a malformed file is an error. A volatile in-memory salt is
// never used as a fallback.
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';

const WEEK_RE = /^\d{4}-\d{2}$/;
const SALT_RE = /^[0-9a-f]{64}$/i;

function parseSaltFile(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 2 || !WEEK_RE.test(parts[0]) || !SALT_RE.test(parts[1])) {
    throw new Error('Telemetry salt file must contain "<YYYY-WW> <32-byte hexadecimal salt>"');
  }
  return { week: parts[0], salt: parts[1].toLowerCase() };
}

async function readSaltFile(filename) {
  try {
    return parseSaltFile(await readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeSaltFile(filename, week, salt) {
  const tmp = `${filename}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${week} ${salt}\n`, { flag: 'wx', mode: 0o600 });
    await rename(tmp, filename);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/**
 * Returns `forWeek(week)`, which resolves to the salt for that ISO week: the persisted one when the
 * file already belongs to `week`, otherwise a new random salt that replaces the file. Calls are
 * serialised, so two pings arriving together at the week boundary share one new salt.
 */
export function createWeeklySalt(filename) {
  let cached = null; // { week, salt }
  let queue = Promise.resolve();

  async function resolve(week) {
    if (!WEEK_RE.test(week)) throw new Error(`invalid week bucket: ${week}`);
    if (cached && cached.week === week) return cached.salt;
    const stored = await readSaltFile(filename);
    if (stored && stored.week === week) {
      cached = stored;
      return stored.salt;
    }
    const salt = randomBytes(32).toString('hex');
    await writeSaltFile(filename, week, salt);
    cached = { week, salt };
    return salt;
  }

  return {
    forWeek(week) {
      const result = queue.then(() => resolve(week));
      queue = result.catch(() => {});
      return result;
    },
  };
}
