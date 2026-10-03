# Audio recovery fixtures

These small configuration files are official model metadata from the public
`onnx-community` repositories on Hugging Face. They exercise the same filename,
size and SHA-256 checks used for local recovery without downloading model weights.

- `Kokoro-82M-v1.0-ONNX.json`: the model's `config.json`.
- `whisper-base.en.json`: the model's `config.json`.
- `whisper-tiny.en.json`: the model's `config.json`.

The tests present these bytes with their original `config.json` filenames and
model folder names. The production manifest lives in `docs/audio-files.js`.
If a model revision changes, update its manifest and matching fixtures together.
Never put downloaded model weights, user recordings, keys or progress here.

Run `node tests/audio-files.cjs` from the repository root. The suite has no network
dependency and checks exact cache destinations, invalid inputs and partial failure.
