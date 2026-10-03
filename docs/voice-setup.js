/* Murmur audio setup: explicit download choice; readiness comes from the workers, never a saved checkbox. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MurmurAudioSetup = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';
  // Consent is remembered for explanation, never as proof that an engine can run.
  // The v2 gate intentionally ignores the earlier optional setup/defer preference.
  const CHOICE_KEY = 'murmur.audio.required.v2';
  /**
   * Build a setup controller around Voice/Ear worker adapters and their mutable state.
   * Callers provide settings/save and optional browser storage/cache or test timers.
   * download()/restore() resolve with {ready, failed, cancelled?}; failures retain
   * completed packs. Subscribe with onChange(), whose return value unsubscribes.
   */
  function create(options) {
    const { voice, ear, settings, save = () => {}, storage, caches: cacheStore } = options;
    const timer = options.setTimeout || setTimeout,
      untimer = options.clearTimeout || clearTimeout;
    const listeners = new Set();
    let busy = false,
      lastError = '',
      lastResult = null,
      job = null,
      generation = 0;
    const cancels = new Set();
    function snapshot() {
      const v = voice.st,
        e = ear.st;
      return {
        busy,
        ready: v.neural === 'ready' && e.local === 'ready',
        voice: {
          state: v.neural,
          progress: Math.max(0, Math.min(100, Number(v.progress) || 0)),
          error: v.why || ''
        },
        recognizer: {
          state: e.local,
          progress: Math.max(0, Math.min(100, Number(e.localProgress) || 0)),
          error: e.lastError || ''
        },
        error: lastError,
        result: lastResult
      };
    }
    const emit = () => {
      const value = snapshot();
      for (const fn of listeners)
        try {
          fn(value);
        } catch {}
    };
    const engine = (which, cacheOnly = false) =>
      which === 'voice'
        ? {
            api: voice,
            key: 'neural',
            start: () => voice.initNeural(true, { cacheOnly }),
            why: () => voice.st.why
          }
        : {
            api: ear,
            key: 'local',
            start: () => ear.initLocal({ cacheOnly }),
            why: () => ear.st.lastError
          };
    // A completed transfer is insufficient: resolve only after the actual worker is ready.
    // Every completion path removes its listener, timeout and cancellation callback.
    function waitFor(which, cacheOnly) {
      const x = engine(which, cacheOnly);
      if (x.api.st[x.key] === 'ready') return Promise.resolve();
      return new Promise((resolve, reject) => {
        let settled = false,
          timeout;
        const cancelWait = () =>
          finish(Object.assign(new Error('Audio setup paused.'), { cancelled: true }));
        const finish = (error) => {
          if (settled) return;
          settled = true;
          cancels.delete(cancelWait);
          untimer(timeout);
          x.api.st.listeners?.delete(changed);
          error ? reject(error) : resolve();
        };
        const changed = () => {
          emit();
          const state = x.api.st[x.key];
          if (state === 'ready') finish();
          else if (state === 'failed')
            finish(
              new Error(
                which === 'voice' && x.why() === 'nogpu'
                  ? 'Natural voice needs WebGPU, which this browser does not provide. Use a compatible browser or device to complete required setup.'
                  : String(x.why() || 'The ' + which + ' pack could not finish.')
              )
            );
        };
        x.api.onChange(changed);
        cancels.add(cancelWait);
        timeout = timer(
          () => {
            if (x.api.reset) x.api.reset();
            else x.api.st.worker?.terminate();
            x.api.st[x.key] = 'failed';
            finish(
              new Error(
                'The ' +
                  which +
                  ' pack took too long to finish. Reconnect and retry; cached files will be reused.'
              )
            );
            emit();
          },
          options.timeoutMs || 20 * 60 * 1000
        );
        Promise.resolve()
          .then(() => {
            if (!settled) return x.start();
          })
          .then(() => {
            if (!settled) changed();
          })
          .catch(finish);
      });
    }
    // Explicit re-download clears only our model entries, preserving the app and study data.
    async function clearModels() {
      if (!cacheStore) throw new Error('This browser cannot manage downloaded model files.');
      const names = await cacheStore.keys();
      let n = 0;
      for (const name of ['transformers-cache', 'kokoro-voices']) {
        if (!names.includes(name)) continue;
        const cache = await cacheStore.open(name);
        for (const request of await cache.keys())
          if (/\/(Kokoro-82M-v1\.0-ONNX|whisper-(base|tiny)\.en)\//i.test(request.url)) {
            await cache.delete(request);
            n++;
          }
      }
      return n;
    }
    // Presence is a cheap hint for returning users, not a completeness or integrity check.
    // restore() still asks both workers to load in cache-only mode before unlocking study.
    async function cached() {
      try {
        if (!cacheStore || (await cacheStore.keys()).indexOf('transformers-cache') < 0)
          return false;
        const urls = (await (await cacheStore.open('transformers-cache')).keys()).map((r) => r.url);
        return (
          urls.some((u) => /Kokoro-82M-v1\.0-ONNX\/.*\.onnx(?:$|\?)/i.test(u)) &&
          urls.some((u) => /whisper-(base|tiny)\.en\/.*encoder.*\.onnx(?:$|\?)/i.test(u)) &&
          urls.some((u) => /whisper-(base|tiny)\.en\/.*decoder.*\.onnx(?:$|\?)/i.test(u))
        );
      } catch {
        return false;
      }
    }
    // Settle worker requests before termination so playback or listening cannot hang.
    // Call this before importing large files to release model memory during hashing.
    function reset() {
      voice.reset?.();
      ear.reset?.();
      voice.stop?.();
      ear.stop?.();
      voice.st.worker?.terminate();
      ear.st.worker?.terminate();
      voice.st.worker = null;
      ear.st.worker = null;
      voice.st.neural = 'off';
      voice.st.progress = 0;
      voice.st.why = '';
      voice.st.engine = 'system';
      voice.st.cache?.clear();
      ear.st.local = 'off';
      ear.st.localProgress = 0;
      ear.st.lastError = '';
      settings.neuralVoice = false;
      settings.localStt = false;
      save();
    }
    function remember(choice) {
      if (choice !== 'download') return false;
      try {
        storage?.setItem(
          CHOICE_KEY,
          JSON.stringify({ confirmed: true, at: new Date().toISOString() })
        );
        return true;
      } catch {
        return false;
      }
    }
    function seen() {
      try {
        return JSON.parse(storage?.getItem(CHOICE_KEY) || 'null')?.confirmed === true;
      } catch {
        return false;
      }
    }
    function apply() {
      if (voice.st.neural === 'ready') {
        settings.neuralVoice = true;
        voice.st.engine = 'neural';
      }
      if (ear.st.local === 'ready') {
        settings.localStt = true;
        settings.earMode = 'local';
      }
      save();
      emit();
      return snapshot().ready;
    }
    // Invalidate the current generation before stopping workers. This also prevents a
    // queued microtask from starting an engine after a reset or file-selection change.
    function cancel() {
      generation++;
      for (const finish of [...cancels]) finish();
      for (const [api, key, progress] of [
        [voice, 'neural', 'progress'],
        [ear, 'local', 'localProgress']
      ])
        if (api.st[key] === 'loading') {
          if (api.reset) api.reset();
          else {
            api.st.worker?.terminate();
            api.st.worker = null;
            api.st[key] = 'off';
            api.st[progress] = 0;
          }
        }
      settings.neuralVoice = voice.st.neural === 'ready';
      settings.localStt = ear.st.local === 'ready';
      save();
      lastError = 'Audio setup paused. Completed files are kept for retry.';
      emit();
    }
    // One shared promise deduplicates repeated clicks. Prepare engines sequentially
    // to limit memory pressure; successful packs survive partial failures and retries.
    function download({ redownload = false, cacheOnly = false } = {}) {
      if (job) return job;
      const own = ++generation;
      busy = true;
      lastError = '';
      lastResult = null;
      if (!cacheOnly) remember('download');
      emit();
      job = (async () => {
        const failed = [];
        try {
          if (redownload) {
            reset();
            await clearModels();
          }
          for (const name of ['voice', 'recognizer']) {
            if (own !== generation) break;
            try {
              await waitFor(name, cacheOnly);
            } catch (e) {
              if (!e.cancelled) failed.push({ pack: name, message: String(e.message || e) });
              // The mandatory voice engine cannot run here; avoid a needless recognizer download.
              if (name === 'voice' && voice.st.why === 'nogpu') break;
            }
          }
          if (own !== generation) {
            lastResult = { ready: snapshot().ready, cancelled: true, failed: [] };
            return lastResult;
          }
          apply();
          lastResult = { ready: snapshot().ready, failed };
          lastError = failed.map((x) => x.message).join(' ');
          return lastResult;
        } catch (e) {
          lastError = String(e.message || e);
          lastResult = { ready: false, failed: [{ pack: 'download', message: lastError }] };
          return lastResult;
        } finally {
          busy = false;
          job = null;
          emit();
        }
      })();
      return job;
    }
    return {
      snapshot,
      download,
      cancel,
      apply,
      cached,
      clearModels,
      restore: () => download({ cacheOnly: true }),
      resetForImport: async () => {
        if (busy) {
          cancel();
          await job;
        }
        reset();
        emit();
      },
      seen,
      remember,
      onChange: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      }
    };
  }
  /**
   * Bind the controller to the existing setup/settings DOM without starting a new
   * download. Cached engines may warm in cache-only mode. Adds open(), isReady()
   * and ensureReady() for the app's navigation/session boundary.
   */
  function mount(options) {
    const { document: d, voice, ear } = options,
      controller = create(options);
    const el = (id) => d.getElementById(id),
      dialog = el('audioSetupDialog');
    const qa = new URLSearchParams(options.search || '').has('qa');
    let restoring = false,
      armed = false,
      importing = false;
    function isReady() {
      return qa || controller.snapshot().ready;
    }
    // The modal is only one part of the gate. Inert screens and the app's study-start
    // guard prevent keyboard or programmatic navigation from bypassing worker readiness.
    function lock(locked) {
      for (const node of d.querySelectorAll?.('main.screen') || []) node.inert = locked;
      d.documentElement?.classList.toggle('audio-required', locked);
    }
    function statusName(pack) {
      return pack.state === 'ready'
        ? 'Ready on this device'
        : pack.state === 'loading'
          ? pack.progress >= 99
            ? 'Preparing the engine…'
            : Math.round(pack.progress) + '% downloaded'
          : pack.state === 'failed'
            ? 'Needs attention'
            : 'Download required';
    }
    function paint(s) {
      const v = s.voice.state === 'ready' ? 100 : s.voice.progress,
        e = s.recognizer.state === 'ready' ? 100 : s.recognizer.progress,
        percent = Math.round((v * 330 + e * 210) / 540);
      let message = s.busy
        ? restoring
          ? 'Checking and loading your saved audio packs…'
          : 'Downloading and preparing both audio packs. Keep Murmur open.'
        : s.ready
          ? 'Both engines are ready. You can start studying.'
          : s.error ||
            'Both packs are required before study begins. Download once on Wi-Fi; they stay on this device.';
      if (s.voice.error === 'nogpu')
        message =
          'This browser cannot run the required natural voice. Open Murmur in a WebGPU-compatible browser or device, then download both packs. Study stays locked until both engines are ready.';
      for (const id of ['audioPackStatus', 'audioDialogStatus'])
        if (el(id)) el(id).textContent = message;
      for (const id of ['audioPackProgress', 'audioDialogProgress'])
        if (el(id)) {
          el(id).hidden = !s.busy;
          el(id).value = percent;
          el(id).setAttribute(
            'aria-valuetext',
            percent + '% of the approximate total transferred; engine preparation may continue.'
          );
        }
      for (const id of ['audioVoiceStatus', 'audioDialogVoice'])
        if (el(id)) {
          el(id).textContent = statusName(s.voice);
          el(id).setAttribute('data-state', s.voice.state);
        }
      for (const id of ['audioRecognizerStatus', 'audioDialogRecognizer'])
        if (el(id)) {
          el(id).textContent = statusName(s.recognizer);
          el(id).setAttribute('data-state', s.recognizer.state);
        }
      for (const id of ['btnAudioPacks', 'audioDownloadBoth'])
        if (el(id)) {
          el(id).disabled = s.busy || importing;
          el(id).textContent = s.busy
            ? 'Preparing both engines…'
            : s.ready
              ? id === 'audioDownloadBoth'
                ? 'Continue to Murmur'
                : 'Apply audio settings'
              : s.error
                ? 'Download missing files & retry'
                : id === 'audioDownloadBoth'
                  ? 'Confirm & download both · about 550 MB'
                  : 'Download both & apply';
        }
      if (el('btnRedownloadAudio')) el('btnRedownloadAudio').disabled = s.busy;
      el('audioPackStatus')?.classList.toggle('has-error', !!s.error && !s.ready);
      el('audioDialogStatus')?.classList.toggle('has-error', !!s.error && !s.ready);
      lock(!qa && !s.ready);
    }
    function open() {
      if (qa) return;
      paint(controller.snapshot());
      if (dialog && !dialog.open) {
        if (dialog.showModal) dialog.showModal();
        else dialog.setAttribute('open', '');
      }
    }
    function close() {
      if (!isReady()) {
        open();
        return;
      }
      if (dialog?.close) dialog.close();
      else dialog?.removeAttribute('open');
      lock(false);
    }
    function ensureReady() {
      if (isReady()) return true;
      open();
      return false;
    }
    async function run(redownload = false, cacheOnly = false) {
      if (importing) return;
      if (options.isSessionRunning?.()) {
        if (el('audioPackStatus'))
          el('audioPackStatus').textContent =
            'Finish the current study session before changing audio engines.';
        return;
      }
      if (!redownload && controller.snapshot().ready) {
        controller.apply();
        paint(controller.snapshot());
        return;
      }
      if (redownload) open();
      await controller.download({ redownload, cacheOnly });
      restoring = false;
      options.refresh?.();
      paint(controller.snapshot());
    }
    controller.onChange(paint);
    voice.onChange(() => paint(controller.snapshot()));
    ear.onChange(() => paint(controller.snapshot()));
    if (el('btnAudioPacks')) el('btnAudioPacks').onclick = () => run();
    if (el('btnRedownloadAudio'))
      el('btnRedownloadAudio').onclick = () => {
        if (!armed) {
          armed = true;
          el('btnRedownloadAudio').textContent = 'Confirm re-download · about 550 MB';
          return;
        }
        armed = false;
        el('btnRedownloadAudio').textContent = 'Re-download both';
        run(true);
      };
    if (el('audioDownloadBoth'))
      el('audioDownloadBoth').onclick = () => {
        if (controller.snapshot().ready) {
          controller.apply();
          close();
        } else run();
      };
    dialog?.addEventListener('cancel', (event) => {
      event.preventDefault();
    });
    dialog?.addEventListener('close', () => {
      if (!isReady()) open();
    });
    // Returning users may warm saved engines without granting permission to fetch
    // missing model files. New network downloads always require the visible button.
    paint(controller.snapshot());
    if (!qa && !controller.snapshot().ready) {
      open();
      controller.cached().then((saved) => {
        if (saved && !controller.snapshot().busy && !controller.snapshot().ready) {
          restoring = true;
          run(false, true);
        }
      });
    }
    function showExisting() {
      open();
      if (el('audioRecovery')) el('audioRecovery').open = true;
    }
    for (const id of ['audioFindFiles', 'btnAudioExisting'])
      if (el(id)) el(id).onclick = showExisting;
    if (el('audioChooseFolder'))
      el('audioChooseFolder').onclick = () => el('audioFolderInput')?.click();
    if (el('audioChooseFiles'))
      el('audioChooseFiles').onclick = () => el('audioFilesInput')?.click();
    // Import only the user-selected files. The recovery module validates official
    // hashes sequentially; calling importFiles directly avoids hashing each file twice.
    async function selected(input) {
      if (importing) return;
      const files = Array.from(input.files || []);
      if (!files.length) return;
      const output = el('audioRecoveryStatus');
      if (!options.filesAPI) {
        output.textContent =
          'File recovery is not available yet. Reopen Murmur while connected to update the app.';
        return;
      }
      if (options.isSessionRunning?.()) {
        output.textContent = 'Finish the study session before replacing audio files.';
        return;
      }
      importing = true;
      open();
      output.textContent = 'Checking selected files against the official model files…';
      for (const id of ['audioChooseFolder', 'audioChooseFiles', 'audioDownloadBoth'])
        if (el(id)) el(id).disabled = true;
      try {
        await controller.resetForImport();
        const modelHint = el('audioModelHint')?.value || undefined;
        const result = await options.filesAPI.importFiles(files, {
          modelHint,
          caches: options.caches,
          onProgress: (p) => {
            output.textContent =
              'Checking and restoring recognized audio files… ' +
              (p.done || p.completed || 0) +
              ' processed.';
          }
        });
        // Filenames and reasons are untrusted file metadata; render diagnostics as text.
        const issues = [
          ...(result.rejected || []).map((x) => ({ name: x.name, reason: x.reason })),
          ...(result.ambiguous || []).map((x) => ({
            name: x.name,
            reason: 'Choose the matching pack: ' + (x.models || []).join(', ')
          }))
        ];
        const issueText = issues.length
          ? '\nFiles needing attention:\n' +
            issues
              .slice(0, 5)
              .map(
                (x) =>
                  String(x.name || 'Selected file').slice(0, 100) +
                  ': ' +
                  String(x.reason || 'Not a recognized model file.').slice(0, 240)
              )
              .join('\n') +
            (issues.length > 5 ? '\n…and ' + (issues.length - 5) + ' more.' : '')
          : '';
        const summary =
          (result.imported || 0) +
          ' files restored; ' +
          (result.skipped || 0) +
          ' already saved; ' +
          (result.rejected?.length || 0) +
          ' unrelated or invalid files ignored; ' +
          (result.ambiguous?.length || 0) +
          ' need a pack selection. ';
        output.textContent = summary + 'Checking the saved engines without downloading…';
        // Local recovery never grants network consent. Missing files remain locked
        // until the user explicitly confirms a download or selects more files.
        restoring = true;
        const checked = await controller.restore();
        restoring = false;
        options.refresh?.();
        output.textContent =
          summary +
          (checked.ready
            ? 'Both saved packs loaded successfully. Continue to Murmur.'
            : 'Both engines could not load yet. Select remaining model files, or confirm Download both to fetch missing files.') +
          issueText;
      } catch (error) {
        output.textContent = 'Files could not be restored: ' + String(error.message || error);
      } finally {
        restoring = false;
        importing = false;
        input.value = '';
        for (const id of ['audioChooseFolder', 'audioChooseFiles'])
          if (el(id)) el(id).disabled = false;
        paint(controller.snapshot());
      }
    }
    for (const id of ['audioFolderInput', 'audioFilesInput'])
      if (el(id)) el(id).onchange = () => selected(el(id));
    return { ...controller, open, isReady, ensureReady };
  }
  return { CHOICE_KEY, create, mount };
});
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const start = () => {
    if (
      typeof Voice === 'undefined' ||
      typeof Ear === 'undefined' ||
      typeof settings === 'undefined'
    )
      return;
    window.murmurAudioSetup = window.MurmurAudioSetup.mount({
      document,
      voice: Voice,
      ear: Ear,
      settings,
      save: saveSettings,
      storage: (() => {
        try {
          return window.localStorage;
        } catch {
          return null;
        }
      })(),
      caches: window.caches,
      filesAPI: window.MurmurAudioFiles,
      search: location.search,
      isSessionRunning: () => typeof Session !== 'undefined' && Session.running,
      refresh: () => {
        if (typeof renderSettings === 'function') renderSettings();
      }
    });
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
