/* Murmur audio recovery. Only user-selected, checksum-verified model files enter
   the model caches. No network requests, directory handles or external links are retained. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MurmurAudioFiles = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';
  // Official Hugging Face metadata, verified 2026-10-03. Keep in step with the workers.
  const MANIFEST = [
    {
      model: 'Kokoro-82M-v1.0-ONNX',
      path: 'config.json',
      size: 44,
      sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f'
    },
    {
      model: 'Kokoro-82M-v1.0-ONNX',
      path: 'onnx/model.onnx',
      size: 325532232,
      sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb'
    },
    {
      model: 'Kokoro-82M-v1.0-ONNX',
      path: 'onnx/model_quantized.onnx',
      size: 92361116,
      sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478'
    },
    {
      model: 'Kokoro-82M-v1.0-ONNX',
      path: 'tokenizer.json',
      size: 3497,
      sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34'
    },
    {
      model: 'Kokoro-82M-v1.0-ONNX',
      path: 'tokenizer_config.json',
      size: 113,
      sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20'
    },
    {
      model: 'Kokoro-82M-v1.0-ONNX',
      path: 'voices/af_heart.bin',
      size: 522240,
      sha256: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b'
    },
    {
      model: 'whisper-base.en',
      path: 'added_tokens.json',
      size: 34604,
      sha256: '560be47bea388757f8d4cc185c5d82067426cbb6361e38016dd90ddc01ab203a'
    },
    {
      model: 'whisper-base.en',
      path: 'config.json',
      size: 2197,
      sha256: 'c8a0de5ed8a083565a4319db29d0c210fda35b4d6076c2d711cae53ae00f3cb1'
    },
    {
      model: 'whisper-base.en',
      path: 'generation_config.json',
      size: 1556,
      sha256: '3479b1f44a07e41db799e22599222fee5816738036def94a39841cb9cdbb4120'
    },
    {
      model: 'whisper-base.en',
      path: 'merges.txt',
      size: 456318,
      sha256: '1ce1664773c50f3e0cc8842619a93edc4624525b728b188a9e0be33b7726adc5'
    },
    {
      model: 'whisper-base.en',
      path: 'normalizer.json',
      size: 52666,
      sha256: 'bf1c507dc8724ca9cf9903640dacfb69dae2f00edee4f21ceba106a7392f26dd'
    },
    {
      model: 'whisper-base.en',
      path: 'onnx/decoder_model_merged_q4.onnx',
      size: 123600371,
      sha256: '7770ac574b71a704191ec52becac42b4a4126af26f54ed653f31c8f16af31f99'
    },
    {
      model: 'whisper-base.en',
      path: 'onnx/decoder_model_merged_quantized.onnx',
      size: 53692803,
      sha256: 'dd4761a3f7add26afda3512abff4706920404c2517e85a9f2ff090b0c0987909'
    },
    {
      model: 'whisper-base.en',
      path: 'onnx/encoder_model.onnx',
      size: 82468078,
      sha256: '1cc86302d480b061452d348638064383ab41b6f3333ddd0e423532d14edaf535'
    },
    {
      model: 'whisper-base.en',
      path: 'onnx/encoder_model_quantized.onnx',
      size: 23201320,
      sha256: '6e8001198c490bbae018c0044f630c2915efb826bad957006ce36152d0ab2a10'
    },
    {
      model: 'whisper-base.en',
      path: 'preprocessor_config.json',
      size: 339,
      sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d'
    },
    {
      model: 'whisper-base.en',
      path: 'special_tokens_map.json',
      size: 2173,
      sha256: '98bdf3ec5b32e31575b02f64b0a32bde7c0449075d34484a7df9bdd3cdeb9fb9'
    },
    {
      model: 'whisper-base.en',
      path: 'tokenizer.json',
      size: 2405679,
      sha256: '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0'
    },
    {
      model: 'whisper-base.en',
      path: 'tokenizer_config.json',
      size: 282662,
      sha256: '93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c'
    },
    {
      model: 'whisper-base.en',
      path: 'vocab.json',
      size: 999186,
      sha256: 'f6bd25a65e4e63ca31360e9fb11c7e4f9a391a78385d640acd814092dd6eee4f'
    },
    {
      model: 'whisper-tiny.en',
      path: 'added_tokens.json',
      size: 34604,
      sha256: '560be47bea388757f8d4cc185c5d82067426cbb6361e38016dd90ddc01ab203a'
    },
    {
      model: 'whisper-tiny.en',
      path: 'config.json',
      size: 2197,
      sha256: '251ea843b5901a99efa58c0b99b8052c6019aa3e7d2baf46693a1128ff606233'
    },
    {
      model: 'whisper-tiny.en',
      path: 'generation_config.json',
      size: 1646,
      sha256: '7b2e8451ed5f118e75fdd991409d72119d21d2fef1eba9723f68fb9c57fe5dc9'
    },
    {
      model: 'whisper-tiny.en',
      path: 'merges.txt',
      size: 456318,
      sha256: '1ce1664773c50f3e0cc8842619a93edc4624525b728b188a9e0be33b7726adc5'
    },
    {
      model: 'whisper-tiny.en',
      path: 'normalizer.json',
      size: 52666,
      sha256: 'bf1c507dc8724ca9cf9903640dacfb69dae2f00edee4f21ceba106a7392f26dd'
    },
    {
      model: 'whisper-tiny.en',
      path: 'onnx/decoder_model_merged_q4.onnx',
      size: 86712166,
      sha256: '57d4303f3bbc8bb4016273b172285236f5719c75e8a7d23b7265cfa1d71494a4'
    },
    {
      model: 'whisper-tiny.en',
      path: 'onnx/decoder_model_merged_quantized.onnx',
      size: 30718858,
      sha256: 'c0592d0749413c960569e1c7fb806b060d5d18f3ebad4a95cbf9a77dc6e9be52'
    },
    {
      model: 'whisper-tiny.en',
      path: 'onnx/encoder_model.onnx',
      size: 32904992,
      sha256: '8c361b9430a5ef6619ee64b7fe06c725df19f36d508cc8b847064b34a888a3fe'
    },
    {
      model: 'whisper-tiny.en',
      path: 'onnx/encoder_model_quantized.onnx',
      size: 10124993,
      sha256: 'e93ec822f16a8fd264e7de972ad17d615ea7334b75a52d54c50c2e18dd503a25'
    },
    {
      model: 'whisper-tiny.en',
      path: 'preprocessor_config.json',
      size: 339,
      sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d'
    },
    {
      model: 'whisper-tiny.en',
      path: 'special_tokens_map.json',
      size: 2173,
      sha256: '98bdf3ec5b32e31575b02f64b0a32bde7c0449075d34484a7df9bdd3cdeb9fb9'
    },
    {
      model: 'whisper-tiny.en',
      path: 'tokenizer.json',
      size: 2405679,
      sha256: '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0'
    },
    {
      model: 'whisper-tiny.en',
      path: 'tokenizer_config.json',
      size: 282662,
      sha256: '93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c'
    },
    {
      model: 'whisper-tiny.en',
      path: 'vocab.json',
      size: 999186,
      sha256: 'f6bd25a65e4e63ca31360e9fb11c7e4f9a391a78385d640acd814092dd6eee4f'
    }
  ];
  const MODELS = [...new Set(MANIFEST.map((x) => x.model))];
  const cacheName = (e) => (e.path.startsWith('voices/') ? 'kokoro-voices' : 'transformers-cache');
  const url = (e) => 'https://huggingface.co/onnx-community/' + e.model + '/resolve/main/' + e.path;
  const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
  function selectedPath(file) {
    return String(file.webkitRelativePath || file.name || '').replace(/\\/g, '/');
  }
  function candidates(file, modelHint) {
    const path = selectedPath(file),
      parts = path.split('/');
    if (
      parts.some((p) => p === '..' || p === '.') ||
      /[\u0000-\u001f]/.test(path) ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0
    )
      return [];
    const named = MODELS.filter((m) => parts.includes(m));
    if (named.length > 1) return [];
    const model = named[0] || modelHint;
    if (model && !MODELS.includes(model)) return [];
    return MANIFEST.filter(
      (e) =>
        (!model || model === e.model) &&
        e.size === file.size &&
        e.path.split('/').at(-1) === parts.at(-1)
    );
  }
  async function verify(file, options) {
    const possible = candidates(file, options.modelHint);
    if (!possible.length)
      return {
        file,
        entries: [],
        reason: 'The name or size does not match a supported Murmur audio file.'
      };
    const crypto = options.crypto || globalThis.crypto;
    if (!crypto?.subtle)
      throw new Error(
        'File verification needs a secure browser connection. Open Murmur over HTTPS.'
      );
    // Check one file at a time. Do not read all model weights into memory together.
    let hash;
    try {
      hash = hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
    } catch {
      throw new Error(
        'Could not read ' + file.name + '. Select the file again from its current folder.'
      );
    }
    const entries = possible.filter((e) => e.sha256 === hash);
    return {
      file,
      entries,
      reason: entries.length
        ? ''
        : 'The file is incomplete, changed, or from a different model version. It was not installed.'
    };
  }
  /** Inspect explicitly selected files without changing the cache. Unknown files are
   * rejected before reading; recognized candidates require an exact official digest.
   * A shared Whisper tokenizer may correctly match both supported recognizers. */
  async function inspect(files, options = {}) {
    const list = Array.from(files || []),
      matches = [],
      rejected = [];
    let bytes = 0;
    if (list.length > 500)
      throw new Error(
        'Select the audio pack folder, not your whole drive (up to 500 files at once).'
      );
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      options.onProgress?.({ phase: 'checking', done: i, total: list.length, name: file.name });
      const result = await verify(file, options);
      if (result.entries.length) {
        matches.push({ file, entries: result.entries, entry: result.entries[0] });
        bytes += file.size;
      } else rejected.push({ name: file.name, reason: result.reason });
    }
    return { matches, rejected, ambiguous: [], bytes };
  }
  // Imports are exclusive. Verification and cache writes are sequential so a phone
  // holds at most one model file for hashing, rather than the full selected folder.
  let importing = null;
  function importFiles(files, options = {}) {
    if (importing)
      return Promise.reject(
        new Error('Another audio file import is running. Wait for it to finish.')
      );
    importing = (async () => {
      const store = options.caches || globalThis.caches;
      if (!store) throw new Error('This browser cannot store offline audio files.');
      const list = Array.from(files || []);
      if (list.length > 500)
        throw new Error('Select only the audio pack folder (up to 500 files).');
      let imported = 0,
        skipped = 0,
        bytes = 0;
      const rejected = [],
        written = new Set(),
        opened = new Map();
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        options.onProgress?.({ phase: 'checking', done: i, total: list.length, name: file.name });
        const result = await verify(file, options);
        if (!result.entries.length) {
          rejected.push({ name: file.name, reason: result.reason });
          continue;
        }
        for (const entry of result.entries) {
          const key = url(entry);
          if (written.has(key)) {
            skipped++;
            continue;
          }
          const name = cacheName(entry);
          if (!opened.has(name)) opened.set(name, await store.open(name));
          const cache = opened.get(name);
          options.onProgress?.({
            phase: 'restoring',
            done: i,
            total: list.length,
            name: file.name
          });
          try {
            await cache.put(
              key,
              new Response(file.stream(), {
                status: 200,
                headers: {
                  'Content-Type': entry.path.endsWith('.json')
                    ? 'application/json'
                    : entry.path.endsWith('.txt')
                      ? 'text/plain'
                      : 'application/octet-stream',
                  'Content-Length': String(file.size),
                  'X-Murmur-SHA256': entry.sha256
                }
              })
            );
          } catch (e) {
            throw new Error(
              e.name === 'QuotaExceededError'
                ? 'There is not enough device storage to restore this pack. Already restored files are kept. Free space and retry.'
                : 'Could not save ' +
                  file.name +
                  '. Already restored files are kept; retry when device storage is available.'
            );
          }
          written.add(key);
          imported++;
          bytes += file.size;
        }
      }
      options.onProgress?.({ phase: 'done', done: list.length, total: list.length });
      return { imported, skipped, rejected, ambiguous: [], bytes };
    })().finally(() => {
      importing = null;
    });
    return importing;
  }
  /** Cheap cache-presence information for UI. This never establishes readiness:
   * the workers must load their model and complete a warm-up before study unlocks. */
  async function inventory(options = {}) {
    const store = options.caches || globalThis.caches,
      models = {};
    let count = 0,
      bytes = 0;
    if (!store) return { count, bytes, models };
    const names = await store.keys();
    for (const name of ['transformers-cache', 'kokoro-voices']) {
      if (!names.includes(name)) continue;
      const cache = await store.open(name);
      for (const request of await cache.keys()) {
        const entry = MANIFEST.find((e) => cacheName(e) === name && url(e) === request.url);
        if (!entry) continue;
        const response = await cache.match(request);
        if (
          !response ||
          response.status !== 200 ||
          Number(response.headers.get('Content-Length')) !== entry.size
        )
          continue;
        models[entry.model] ||= { count: 0, bytes: 0, files: [] };
        models[entry.model].count++;
        models[entry.model].bytes += entry.size;
        models[entry.model].files.push(entry.path);
        count++;
        bytes += entry.size;
      }
    }
    // Presence is informational. A worker must still load and warm up before the app says Ready.
    return { count, bytes, models };
  }
  return { MODELS, MANIFEST, inspect, importFiles, inventory };
});
