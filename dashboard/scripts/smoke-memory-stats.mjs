import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentma-memory-stats-'));
process.env.AGENTMA_USER_MEMORY_DIR = root;

const memory = await import('../server-memory.ts');
const agent = await import('../server-agent.ts');

const auth = { tenantId: 'tenant-smoke', sub: 'user-smoke' };
const userDir = memory.userMemoryDir(auth);

function reset() {
  fs.rmSync(userDir, { recursive: true, force: true });
}

function remember(name, body, description = `${name} summary`) {
  memory.writeMemory(auth, { name, description, type: 'project', body });
}

function statsFile() {
  return path.join(userDir, 'memory-stats.json');
}

function readStats() {
  return JSON.parse(fs.readFileSync(statsFile(), 'utf-8'));
}

try {
  reset();
  remember('relevant', 'relevant secret body');
  remember('unrelated', 'unrelated secret body');

  const index = memory.readMemoryIndex(auth);
  assert.match(index, /relevant summary/);
  assert.doesNotMatch(index, /relevant secret body/);
  assert.doesNotMatch(index, /unrelated secret body/);

  fs.writeFileSync(statsFile(), JSON.stringify({
    relevant: { injectionCount: 99, lastInjectedAt: Date.now() },
    unrelated: { injectionCount: 99, lastInjectedAt: Date.now() },
  }), 'utf-8');
  assert.equal(memory.readMemory(auth, 'relevant')?.recallCount, 0, 'legacy injection counts reset to zero');
  assert.equal(memory.readMemory(auth, 'unrelated')?.recallCount, 0);

  const firstRecall = memory.recallMemories(auth, ['relevant']);
  assert.deepEqual(firstRecall.recalledNames, ['relevant']);
  assert.match(firstRecall.text, /relevant secret body/);
  assert.equal(memory.readMemory(auth, 'relevant')?.recallCount, 1);
  assert.equal(memory.readMemory(auth, 'unrelated')?.recallCount, 0, 'unrelated memory does not increment');
  assert.equal(readStats().version, 2);

  memory.recallMemories(auth, ['relevant', 'relevant']);
  assert.equal(memory.readMemory(auth, 'relevant')?.recallCount, 2, 'duplicate names count once per request');
  memory.recallMemories(auth, ['relevant']);
  assert.equal(memory.readMemory(auth, 'relevant')?.recallCount, 3, 'separate requests increment separately');

  const missingRecall = memory.recallMemories(auth, ['missing']);
  assert.deepEqual(missingRecall.recalledNames, []);
  assert.deepEqual(missingRecall.omittedNames, ['missing']);

  remember('unreadable', 'cannot read this');
  fs.rmSync(path.join(userDir, 'unreadable.md'));
  fs.mkdirSync(path.join(userDir, 'unreadable.md'));
  const unreadableRecall = memory.recallMemories(auth, ['unreadable']);
  assert.deepEqual(unreadableRecall.recalledNames, []);
  assert.deepEqual(unreadableRecall.omittedNames, ['unreadable']);
  fs.rmSync(path.join(userDir, 'unreadable.md'), { recursive: true, force: true });

  reset();
  remember('a-large', 'a'.repeat(10_900));
  remember('b-partial', 'b'.repeat(3_000));
  remember('c-excluded', 'excluded body');
  const limitedRecall = memory.recallMemories(auth, ['a-large', 'b-partial', 'c-excluded']);
  assert.deepEqual(limitedRecall.recalledNames, ['a-large', 'b-partial']);
  assert.deepEqual(limitedRecall.omittedNames, ['c-excluded']);
  assert.equal(memory.readMemory(auth, 'a-large')?.recallCount, 1);
  assert.equal(memory.readMemory(auth, 'b-partial')?.recallCount, 1, 'partially returned final memory counts');
  assert.equal(memory.readMemory(auth, 'c-excluded')?.recallCount, 0, 'output-limit omission does not count');

  memory.listMemories(auth);
  memory.readMemory(auth, 'a-large');
  assert.equal(memory.readMemory(auth, 'a-large')?.recallCount, 1, 'REST-equivalent reads do not increment');

  fs.writeFileSync(statsFile(), '{broken', 'utf-8');
  const recoveredRecall = memory.recallMemories(auth, ['a-large']);
  assert.deepEqual(recoveredRecall.recalledNames, ['a-large']);
  assert.equal(readStats().version, 2, 'successful recall replaces malformed stats');

  memory.deleteMemory(auth, 'b-partial');
  assert.equal(Object.hasOwn(readStats().memories, 'b-partial'), false, 'delete removes recall statistics');

  remember('duplicate-one', 'same body');
  remember('duplicate-two', 'same body');
  memory.recordMemoryRecalls(auth, ['duplicate-one', 'duplicate-two', 'orphan']);
  memory.consolidateMemories(auth);
  const remainingNames = new Set(memory.listMemories(auth).map(item => item.name));
  const consolidatedStats = readStats().memories;
  assert.equal(Object.hasOwn(consolidatedStats, 'orphan'), false, 'consolidation removes orphan statistics');
  assert.equal(Object.keys(consolidatedStats).every(name => remainingNames.has(name)), true, 'removed duplicate statistics are discarded');

  assert.equal(agent.shouldEnableMemoryForRun({ tenantId: 'tenant', sub: 'user' }), true, 'ordinary runs default memory on');
  assert.equal(agent.shouldEnableMemoryForRun({ tenantId: 'tenant', sub: 'user', useMemory: false }), false, 'ordinary runs can disable memory');

  console.log('memory recall smoke passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
