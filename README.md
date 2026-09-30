# Pandora Practice Pal

Hands-free lecture and tutor app for the Pandora vault (DIGI 210, ELTR 238, MATH 237, EFAB 202).
Served from `docs/` by GitHub Pages; install it from Chrome on the phone ("Add to Home screen").

- `docs/bank.json` — the question bank and lecture scripts. Rebuilt by `Resources/Practice/Drive/sync.py` in the vault after each day's notes are created, then pushed here.
- `progress.json` — written by the app (with a GitHub token in its settings) after each drive; the vault sync reads it back into `Resources/Practice/Drive/Drive Progress.md`.
