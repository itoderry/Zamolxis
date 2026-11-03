/**
 * Checks the speech service client (src/core/voice/speechService.ts) and WhisperServer's routing against a fake
 * service on 127.0.0.1. The sidecar is stubbed, so no whisper-server starts and the GPU is not touched; the data
 * folder is a temporary one, so the real endpoint file is never read or written.
 *   npx tsx scripts/test-speech-service.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zam-speechservice-'));
process.env.SPEECHSERVICE_HOME = home;
process.env.SPEECHSERVICE_EXE = '';          // "not installed": never starts the real service

const { SpeechServiceClient, connectService } = await import('../src/core/voice/speechService.js');
const { WhisperServer, stopWhisperServers } = await import('../src/core/voice/whisperServer.js');
const { effectiveVoiceSettings, sanitizeVoiceOverrides } = await import('../src/core/voice/claudeVoiceConfig.js');

function wav(seconds: number): Buffer {
  const data = Buffer.alloc(16000 * 2 * seconds);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// --- a fake speech service
const TOKEN = 'test-token';
let mode: 'ok' | 'bad-audio' | 'down' = 'ok';
const seen: Array<{ auth?: string; origin?: string; body: string }> = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('latin1');
    seen.push({ auth: req.headers.authorization, origin: req.headers.origin, body });
    const send = (code: number, j: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'missing or wrong token' });
    if (req.url === '/v1/status') return send(200, { state: 'ready', mode: 'auto', device: 'cuda', model: 'large-v3', degraded: false });
    if (req.url === '/v1/transcribe') {
      if (mode === 'bad-audio') return send(400, { error: 'not a WAV file' });
      if (mode === 'down') return send(503, { error: 'no speech model is loaded' });
      return send(200, { text: ' hello from the service ', language: 'ro', device: 'cuda', model: 'large-v3' });
    }
    send(404, { error: 'not found' });
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as { port: number }).port;
fs.writeFileSync(path.join(home, 'endpoint.json'), JSON.stringify({ port, token: TOKEN, pid: 0 }));

let failures = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + (e as Error).message); }
}
const opts = { client: 'zamolxis', priority: 'interactive' as const, task: 'translate' as const, languages: ['en', 'ro'], prompt: 'Hello Zam.', beam_size: 5 };

await test('connect reads the endpoint file and the status', async () => {
  const c = await connectService(false, 0);
  assert.ok(c);
  assert.equal(c.ep.port, port);
  assert.equal(c.status.model, 'large-v3');
});

await test('transcribe sends the token, no Origin, the WAV and the options', async () => {
  seen.length = 0;
  const r = await new SpeechServiceClient().transcribe(wav(1), opts, 1000);
  assert.deepEqual(r, { text: 'hello from the service', lang: 'ro', device: 'gpu', model: 'large-v3' });
  const t = seen.find((s) => s.body.includes('name="audio"'))!;
  assert.equal(t.auth, `Bearer ${TOKEN}`);
  assert.equal(t.origin, undefined);
  assert.ok(t.body.includes('RIFF') && t.body.includes('"client":"zamolxis"') && t.body.includes('"task":"translate"') && t.body.includes('"languages":["en","ro"]'));
});

await test('refused audio is an error, not a fallback', async () => {
  mode = 'bad-audio';
  await assert.rejects(new SpeechServiceClient().transcribe(wav(1), opts, 1000), /not a WAV file/);
  mode = 'ok';
});

await test('a failing service gives null, then is not asked again for a minute', async () => {
  mode = 'down';
  const c = new SpeechServiceClient();
  assert.equal(await c.transcribe(wav(1), opts, 500), null);
  mode = 'ok';
  seen.length = 0;
  assert.equal(await c.transcribe(wav(1), opts, 500), null);
  assert.equal(seen.length, 0);
  assert.ok(c.status().lastError?.startsWith('503'));
});

// WhisperServer with the sidecar stubbed: which path answers
function whisper(backend: 'auto' | 'service' | 'sidecar') {
  const w = new WhisperServer(() => effectiveVoiceSettings({ backend }));
  let sidecarCalls = 0;
  (w as unknown as { transcribeNow: () => Promise<unknown> }).transcribeNow = async () => {
    sidecarCalls++;
    return { text: 'from the sidecar', lang: 'en', ms: 1, device: 'gpu' };
  };
  return { w, calls: () => sidecarCalls };
}

await test('auto: the service answers, the sidecar is not used', async () => {
  const { w, calls } = whisper('auto');
  const r = await w.transcribe(wav(1));
  assert.equal(r.text, 'hello from the service');
  assert.equal(calls(), 0);
  assert.equal(w.status().service.inUse, true);
  assert.equal(w.status().state, 'stopped');
});

await test('sidecar: the service is not asked', async () => {
  const { w, calls } = whisper('sidecar');
  seen.length = 0;
  const r = await w.transcribe(wav(1));
  assert.equal(r.text, 'from the sidecar');
  assert.equal(calls(), 1);
  assert.equal(seen.length, 0);
});

await test('auto: no service answering falls back to the sidecar', async () => {
  fs.writeFileSync(path.join(home, 'endpoint.json'), JSON.stringify({ port: 1, token: TOKEN }));
  const { w, calls } = whisper('auto');
  const r = await w.transcribe(wav(1));
  assert.equal(r.text, 'from the sidecar');
  assert.equal(calls(), 1);
});

await test('settings keep a valid backend and drop others', () => {
  assert.equal(sanitizeVoiceOverrides({ backend: 'service' }).backend, 'service');
  assert.equal(sanitizeVoiceOverrides({ backend: 'gpu' }).backend, undefined);
  assert.equal(effectiveVoiceSettings({}).backend, 'auto');
});

stopWhisperServers();
server.close();
fs.rmSync(home, { recursive: true, force: true });
console.log(failures ? `${failures} FAILED` : 'SPEECH SERVICE CLIENT OK');
process.exit(failures ? 1 : 0);
