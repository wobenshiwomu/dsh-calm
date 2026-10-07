# dsh-calm

> A DeepSeek Harness plugin: **Emotional Checkpoint & Repair**.
> When the user turns abusive, dsh-calm neither fights back nor pretends nothing happened —
> it enters a soothing mode, then folds & seals the heated exchange, injects a distilled
> summary, and resumes the task from a clean context.

Compatible with DSH `>=0.2.0-rc.1` (developer preview; breaking changes will be followed).

## How it works

1. **Trigger** — an `agent/pre-step` listener classifies the incoming (not-yet-committed) user
   message: `abuse` / `noise` / `mixed` / `substantive` / `distress` (safety exception).
2. **Soothing mode** — injects a calm note into the same turn's message batch (acknowledge, don't
   argue, don't over-apologize, clarify the real intent). A `tools.guard` temporarily blocks
   side-effect tools so nothing is executed mid-argument.
3. **Recovery (fold + summarize)** — once the user gives a substantive instruction, the heated span
   is folded from the *model-visible surface* via `surfaceOp: replace` and replaced by a summary
   message (metadata recorded in `source.calm`). **The append-only session log keeps every line.**
4. **Rolling-window termination** — N consecutive rounds (default 5) without substance in soothe
   mode → fold & seal, then a mechanical `{kind:'reject'}` ends the session. Distress signals
   disable termination entirely (safety carve-out).
5. **Access policy** — the model can read sealed records via the `open_sealed` tool (reason
   required, redacted by default, raw text only with `allowRawSealedRead`, every read audited).
   `end_conversation` lets the model end a session as a last resort.
6. **Crash-safe** — in-flight soothe state is reconstructed from the session log after a restart.

## Install

**Via GitHub archive (recommended; direct-download friendly incl. mainland China, no npm account needed)**:

```sh
dsh plugin --profile web add 'https://codeload.github.com/wobenshiwomu/dsh-calm/tar.gz/v0.1.0'
```

Or via the GUI plugin manager: sidebar → Plugins → Add plugin → paste the URL above. Restart DSH to apply.
The `v0.1.0` segment is the version tag; upgrade by reinstalling with a newer tag.

**Via npm (not published yet)**: once it is, `dsh plugin --profile web add dsh-calm` will work.

**Local source mount (for development; hot-reloads on edit)**:

In your profile's user layer `~/.dsh/profiles/<name>/cordis.patch.yml`, mount the entry by absolute path:

```yaml
- insert:
    - id: dsh-calm
      name: '/absolute/path/to/dsh-calm/src/index.mjs'
      config: { window: 5, enableTermination: true, allowRawSealedRead: false }
```

Restart DSH to apply.

## Config

| key | default | meaning |
|---|---|---|
| `window` | `5` | consecutive no-substance rounds before the session ends |
| `enableTermination` | `true` | enable rolling-window termination |
| `denyPattern` | `bash\|shell\|pwsh\|write\|edit\|…` | tool-name regex blocked during soothe mode |
| `allowRawSealedRead` | `false` | allow the model to read raw sealed text |

## Audit

Audit metadata lives in the `source.calm` field of calm messages
(`subtypes`: `soothe`, `sealed`, `terminated`, `read`, `reminder`).
Custom event types are avoided deliberately: DSH readers only accept known event types or events
marked `ignorable`, and this DSH version does not expose the `ignorable` marker to plugins —
`user/message.source` is shallow-validated and preserved, making it the natural audit slot.

## Known limits

- The summary is a heuristic digest today; an LLM summarizer is the planned upgrade.
- File-state rollback is out of scope — pair with `dsh-rewind` for manual rewind.
- Rule-based classifier by design (deterministic judge); swap `classify()` for a model later.

## Test

```sh
npm install   # one-time: host deps needed by the tests (@deepseek-ai/dsh-llm, …)
npm test      # = node test/sim.mjs (53 assertions)
```

## License

MIT
