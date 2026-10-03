# Murmur engineering and documentation

These conventions apply to software in this workspace, including Murmur, the DIGI workbench, and the Obsidian practice integration. They do not require rewriting study notes or third-party code.

- Preserve established behavior, saved data, branding, accessibility, and the repository's coding conventions. Prefer small, cohesive changes over new frameworks or duplicate systems.
- Keep handwritten code readable: descriptive names, two-space indentation where already used, and normal line breaks. Generated question banks and vendored libraries may remain compact; identify their source or generator.
- Give each module a short statement of responsibility and its boundaries. Document public entry points, their inputs and outputs, asynchronous completion, and meaningful failure conditions.
- Explain non-obvious decisions and invariants near the code that depends on them. In particular, document audio ownership/cancellation, storage and migration, evidence grading, time units, retry policy, and provider billing gates. Do not narrate obvious syntax.
- Update implementation, nearby comments, developer documentation, and relevant tests together whenever behavior changes. Remove stale claims. Describe limitations accurately; distinguish mocked checks, browser checks, and real-device checks.
- Keep one documented implementation of shared learning and sync logic. Propagate it to each app and the Obsidian integration, then verify compatibility and copies before release.
- Documentation must not become runtime processing. Avoid extra downloads, dependencies, background tasks, logging, or generated documentation payloads in the user interface merely to support documentation.
- Save learning progress locally before syncing. Sync must not invoke an AI model. Respect server rate limits and preserve queued progress during failures. Keep normal AI response routing independent of background sync throttles.
- Optional paid providers remain off by default and require clear billing consent. Never place an owner's API key in a distributed app. Never include credentials in learning events, exports, logs, test fixtures, or documentation.
- Check the whole flow: first run, returning users, offline operation, interrupted setup, keyboard and phone layouts, and data recovery. Run focused regression tests after behavioral changes; do not claim that tests prove the absence of bugs.

Before handoff, review the interface as a complete study experience and explain what was verified and what still requires the user's device or connection.
