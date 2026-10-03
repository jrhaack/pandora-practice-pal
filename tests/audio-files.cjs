'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  A = require('../docs/audio-files.js');
let count = 0;
async function test(name, fn) {
  try {
    await fn();
    count++;
  } catch (e) {
    console.error('FAIL', name);
    throw e;
  }
}
const voice = 'Kokoro-82M-v1.0-ONNX',
  base = 'whisper-base.en',
  tiny = 'whisper-tiny.en';
function config(model = voice, rel = '', alter = false) {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures/audio', model + '.json'));
  if (alter) raw[raw.length - 2] ^= 1;
  const f = new File([raw], 'config.json');
  Object.defineProperty(f, 'webkitRelativePath', { value: rel });
  return f;
}
function cacheStore() {
  const caches = new Map();
  return {
    async keys() {
      return [...caches.keys()];
    },
    async open(name) {
      if (!caches.has(name)) {
        const entries = new Map();
        caches.set(name, {
          entries,
          async put(key, response) {
            entries.set(
              key,
              new Response(await response.arrayBuffer(), {
                status: response.status,
                headers: response.headers
              })
            );
          },
          async keys() {
            return [...entries.keys()].map((url) => new Request(url));
          },
          async match(key) {
            return entries.get(typeof key === 'string' ? key : key.url)?.clone();
          }
        });
      }
      return caches.get(name);
    }
  };
}
(async () => {
  await test('official manifest fixed to worker model families', () => {
    assert.equal(A.MANIFEST.length, 34);
    assert.deepEqual(A.MODELS, [voice, base, tiny]);
    assert(A.MANIFEST.every((e) => /^[a-f0-9]{64}$/.test(e.sha256) && e.size > 0));
  });
  await test('find moved parent folder by supported model name', async () => {
    const r = await A.inspect([config(voice, 'moved/backups/' + voice + '/config.json')]);
    assert.equal(r.matches[0].entry.model, voice);
  });
  await test('identify renamed pack folder by content', async () => {
    const r = await A.inspect([config(voice, 'My saved voice/config.json')]);
    assert.equal(r.matches[0].entry.model, voice);
  });
  await test('loose config base and tiny same size resolve by checksum', async () => {
    assert.equal((await A.inspect([config(base)])).matches[0].entry.model, base);
    assert.equal((await A.inspect([config(tiny)])).matches[0].entry.model, tiny);
  });
  await test('wrong selected model is rejected', async () =>
    assert.equal((await A.inspect([config(base)], { modelHint: voice })).matches.length, 0));
  await test('same-size corruption does not enter the cache', async () => {
    const store = cacheStore(),
      r = await A.importFiles([config(voice, '', true)], { caches: store });
    assert.equal(r.imported, 0);
    assert.match(r.rejected[0].reason, /incomplete/);
    assert.deepEqual(await store.keys(), []);
  });
  await test('path traversal rejected before reading', async () =>
    assert.equal((await A.inspect([config(voice, '../config.json')])).matches.length, 0));
  await test('unrelated selected files are ignored without reading', async () => {
    const f = {
      name: 'personal-notes.txt',
      size: 22,
      arrayBuffer() {
        throw Error('must not read');
      }
    };
    const r = await A.importFiles([f], { caches: cacheStore() });
    assert.equal(r.rejected.length, 1);
  });
  await test('empty and pointer files are not models', async () => {
    for (const size of [0, 134])
      assert.equal((await A.inspect([{ name: 'model.onnx', size }])).matches.length, 0);
  });
  await test('valid files restore exact Transformers cache keys', async () => {
    const store = cacheStore(),
      r = await A.importFiles([config()], { caches: store });
    assert.equal(r.imported, 1);
    const c = await store.open('transformers-cache');
    const url = 'https://huggingface.co/onnx-community/' + voice + '/resolve/main/config.json';
    const hit = await c.match(url);
    assert.equal(hit.status, 200);
    assert.equal(
      await hit.text(),
      fs.readFileSync(path.join(__dirname, 'fixtures/audio', voice + '.json'), 'utf8')
    );
    assert.equal(hit.headers.get('Content-Length'), '44');
  });
  await test('duplicate selection writes once', async () => {
    const r = await A.importFiles([config(), config()], { caches: cacheStore() });
    assert.equal(r.imported, 1);
    assert.equal(r.skipped, 1);
  });
  await test('successful files retained if next file corrupt', async () => {
    const store = cacheStore(),
      r = await A.importFiles([config(), config(base, '', true)], { caches: store });
    assert.equal(r.imported, 1);
    assert.equal(r.rejected.length, 1);
    assert.equal((await A.inventory({ caches: store })).count, 1);
  });
  await test('inventory reports presence without readiness claim', async () => {
    const store = cacheStore();
    await A.importFiles([config(), config(base)], { caches: store });
    const r = await A.inventory({ caches: store });
    assert.equal(r.count, 2);
    assert.equal(r.bytes, 2241);
    assert.equal(r.ready, undefined);
  });
  await test('empty cache scan does not create model caches', async () => {
    const store = cacheStore();
    assert.equal((await A.inventory({ caches: store })).count, 0);
    assert.deepEqual(await store.keys(), []);
  });
  await test('import makes no network requests', async () => {
    const old = global.fetch;
    global.fetch = () => {
      throw Error('network forbidden');
    };
    try {
      assert.equal((await A.importFiles([config()], { caches: cacheStore() })).imported, 1);
    } finally {
      global.fetch = old;
    }
  });
  await test('permission lost on moved file gives actionable message', async () => {
    const f = {
      name: 'config.json',
      size: 44,
      arrayBuffer: async () => {
        throw Error('NotReadableError');
      }
    };
    await assert.rejects(() => A.importFiles([f], { caches: cacheStore() }), /current folder/);
  });
  await test('storage exhaustion preserves previous cache contents', async () => {
    const store = cacheStore();
    await A.importFiles([config()], { caches: store });
    const c = await store.open('transformers-cache');
    c.put = async () => {
      const e = Error();
      e.name = 'QuotaExceededError';
      throw e;
    };
    await assert.rejects(
      () => A.importFiles([config(base)], { caches: store }),
      /Already restored files are kept/
    );
    assert.equal((await A.inventory({ caches: store })).count, 1);
  });
  await test('bounded selections fail before reading', async () =>
    await assert.rejects(
      () => A.importFiles(Array(501).fill(config()), { caches: cacheStore() }),
      /500 files/
    ));
  await test('concurrent imports rejected without interrupting original', async () => {
    const store = cacheStore();
    let release;
    const c = await store.open('transformers-cache'),
      put = c.put;
    c.put = async (...args) => {
      await new Promise((r) => (release = r));
      return put(...args);
    };
    const job = A.importFiles([config()], { caches: store });
    await assert.rejects(
      () => A.importFiles([config()], { caches: store }),
      /Another audio file import/
    );
    while (!release) await new Promise((r) => setImmediate(r));
    release();
    assert.equal((await job).imported, 1);
  });
  await test('progress completes in order', async () => {
    const steps = [];
    await A.importFiles([config()], { caches: cacheStore(), onProgress: (p) => steps.push(p) });
    assert.deepEqual(
      steps.map((p) => p.phase),
      ['checking', 'restoring', 'done']
    );
  });
  console.log(count + ' audio file recovery tests passed');
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
