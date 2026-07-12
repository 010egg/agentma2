import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TranscribeQueue } from '../server-transcribe-service.ts';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeFixture(filePath, content = 'fixture') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentma-transcribe-smoke-'));
  const cwdA = path.join(root, 'run-a');
  const cwdB = path.join(root, 'run-b');
  fs.mkdirSync(cwdA);
  fs.mkdirSync(cwdB);
  const audioA = path.join(cwdA, 'audio.wav');
  const audioB = path.join(cwdB, 'other.wav');
  writeFixture(audioA);
  writeFixture(audioB);

  let activeWorkers = 0;
  let maxActiveWorkers = 0;
  const queue = new TranscribeQueue({
    timeoutMs: 2_000,
    maxOutstandingPerTenant: 2,
    allowedUrlHostSuffixes: ['amemv.com'],
    probeMedia: async (source) => source.value.includes('too-long') ? 3_601 : 12.5,
    runWorker: async (request) => {
      activeWorkers += 1;
      maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
      await delay(80);
      activeWorkers -= 1;
      return {
        text: `transcript:${request.outputName}`,
        outputPath: `transcripts/${request.outputName}`,
      };
    },
  });

  assert.deepEqual(await queue.transcribe({
    tenantId: 'tenant-a', cwd: cwdA, source: { url: 'https://example.com/video.mp4' },
  }), { ok: false, error: 'media_host_not_allowed' });
  assert.deepEqual(await queue.transcribe({
    tenantId: 'tenant-a', cwd: cwdA, source: { audioPath: '/etc/hosts' },
  }), { ok: false, error: 'audio_path_outside_workspace' });
  assert.deepEqual(await queue.transcribe({
    tenantId: 'tenant-a', cwd: cwdA, source: { audioPath: audioB },
  }), { ok: false, error: 'audio_path_outside_workspace' });

  const escapeLink = path.join(cwdA, 'escape.wav');
  fs.symlinkSync('/etc/hosts', escapeLink);
  assert.deepEqual(await queue.transcribe({
    tenantId: 'tenant-a', cwd: cwdA, source: { audioPath: escapeLink },
  }), { ok: false, error: 'audio_path_outside_workspace' });

  const hugeFile = path.join(cwdA, 'huge.wav');
  writeFixture(hugeFile, '');
  fs.truncateSync(hugeFile, 500 * 1024 * 1024 + 1);
  assert.deepEqual(await queue.transcribe({
    tenantId: 'tenant-a', cwd: cwdA, source: { audioPath: hugeFile },
  }), { ok: false, error: 'audio_file_too_large' });

  const tooLong = await queue.transcribe({
    tenantId: 'tenant-a', cwd: cwdA, source: { url: 'https://video.amemv.com/too-long.mp4' },
  });
  assert.deepEqual(tooLong, { ok: false, error: 'media_too_long' });

  const concurrent = Array.from({ length: 4 }, () => queue.transcribe({
    tenantId: 'tenant-queue', cwd: cwdA, source: { audioPath: audioA },
  }));
  const concurrentResults = await Promise.all(concurrent);
  assert.equal(concurrentResults.filter((result) => result.ok).length, 2);
  assert.equal(concurrentResults.filter((result) => !result.ok && result.error === 'tenant_queue_full_try_later').length, 2);
  assert.equal(maxActiveWorkers, 1, 'transcription workers must be globally serial');

  let timedWorkerStarted = false;
  const timeoutQueue = new TranscribeQueue({
    timeoutMs: 1_000,
    maxOutstandingPerTenant: 2,
    probeMedia: async () => 5,
    runWorker: async (request, signal) => {
      if (!timedWorkerStarted) {
        timedWorkerStarted = true;
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return { text: 'next task', outputPath: `transcripts/${request.outputName}` };
    },
  });
  const timed = timeoutQueue.transcribe({ tenantId: 'timeout-a', cwd: cwdA, source: { audioPath: audioA } });
  const next = timeoutQueue.transcribe({ tenantId: 'timeout-b', cwd: cwdB, source: { audioPath: audioB } });
  assert.deepEqual(await timed, { ok: false, error: 'transcribe_timeout' });
  assert.equal((await next).ok, true, 'queue should continue after a timed out worker');

  if (process.env.AGENTMA_SMOKE_TRANSCRIBE_LIVE === '1') {
    const liveCwd = path.join(root, 'live');
    fs.mkdirSync(liveCwd);
    const liveAudio = path.join(liveCwd, 'tone.wav');
    const generated = spawnSync('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-ar', '16000', '-ac', '1', liveAudio,
    ], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const liveQueue = new TranscribeQueue();
    const live = await liveQueue.transcribe({ tenantId: 'live-tenant', cwd: liveCwd, source: { audioPath: liveAudio } });
    assert.equal(live.ok, true, live.ok ? '' : live.error);
    assert.equal(fs.existsSync(path.join(liveCwd, live.outputPath)), true);
    console.log('live offline transcription:', JSON.stringify(live));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('transcribe smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
