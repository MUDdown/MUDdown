---
name: osc8-bridge
description: Add or modify OSC 8 hyperlink capabilities in the telnet bridge — NEW-ENVIRON (RFC 1572) negotiation, Mudlet/Fado/MudForge `send:` URIs, and per-scheme tooltip/menu metadata. Covers the capability pipeline from telnet negotiation through renderer output, the sanitization contract, and the word-wrap invariant.
---

# OSC 8 Bridge Skill

You are extending MUDdown's telnet bridge so legacy MUD clients (Mudlet, Fado, MudForge, …) can render MUDdown game links as native clickable hyperlinks via OSC 8. The feature is always capability-gated: a client must advertise the capability by NEW-ENVIRON USERVAR before the bridge emits the richer form.

## Specs and References

- **OSC 8 terminal hyperlinks**: `ESC ] 8 ; params ; URI ST … ESC ] 8 ; ; ST`. ST is either BEL (`0x07`) or `ESC \` (`0x1b 0x5c`).
- **Mudlet OSC 8 extensions** (tiers 1–6): https://wiki.mudlet.org/w/Manual:OSC — adds `send:` / `prompt:` URI schemes, a `?config=<percent-encoded-JSON>` query param carrying tooltip and menu, and reserves `config` and `preset` param names when the advertised capabilities are present.
- **NEW-ENVIRON** (RFC 1572): telnet option 39. Clients that support the Mudlet OSC 8 extensions advertise capabilities as USERVARs whose names start with `OSC_HYPERLINKS`.
- **4096-byte URL cap**: Mudlet silently drops URIs longer than this. The renderer caps each config string field at 200 Unicode code points as a defensive margin.

## Capability Names

| USERVAR | What it unlocks | Renderer flag |
|---------|-----------------|---------------|
| `OSC_HYPERLINKS` | Render external URLs as OSC 8 hyperlinks (e.g. the login URL) | Implicit in bridge code |
| `OSC_HYPERLINKS_SEND` | Map MUDdown game links to `send:<command>` URIs | Auto-enables `osc8-send` link mode |
| `OSC_HYPERLINKS_TOOLTIP` | Attach a `tooltip` field in `?config=` JSON | `Osc8Features.tooltip = true` |
| `OSC_HYPERLINKS_MENU` | Attach a `menu` array of related actions in `?config=` JSON | `Osc8Features.menu = true` |

A client that advertises only `OSC_HYPERLINKS_SEND` gets bare `send:<cmd>` URIs — no `?config=`. A client that advertises tooltip/menu without `OSC_HYPERLINKS_SEND` gets **neither** `send:` nor config (capabilities are cumulative: you need `SEND` before tooltip/menu enrichment is meaningful).

## Pipeline Overview

```
Client   ──IAC WILL NEW-ENVIRON──▶  Bridge
Client   ◀──IAC SB NEW-ENVIRON SEND USERVAR OSC_HYPERLINKS_* …  Bridge
Client   ──IAC SB NEW-ENVIRON IS USERVAR … VALUE 1 … IAC SE──▶  Bridge
                                                                 │
                                                                 ▼
                                              this.capabilities.add(name)
                                                                 │
                                    ┌────────────────────────────┘
                                    ▼
                    deriveLinkMode(override, capabilities)
                           → "osc8-send" | "numbered" | "plain"
                                    │
                                    ▼
                    renderTerminal(muddown, {
                      linkMode,
                      osc8Features: { tooltip, menu }
                    })
                                    │
                                    ▼
                   ESC]8;;send:<urlencoded-cmd>?config=…ESC\<text>ESC]8;;ESC\
```

## Key Files

| File | Responsibility |
|------|----------------|
| [packages/bridge/src/telnet.ts](../../../packages/bridge/src/telnet.ts) | IAC negotiation; NEW-ENVIRON SEND request listing the capability names we care about; NEW-ENVIRON IS response parser |
| [packages/bridge/src/bridge.ts](../../../packages/bridge/src/bridge.ts) | `capabilities: Set<string>`; `effectiveLinkMode` getter; `renderAndSend` builds `Osc8Features` from capabilities and passes to `renderTerminal` |
| [packages/bridge/src/helpers.ts](../../../packages/bridge/src/helpers.ts) | `deriveLinkMode`, `nextLinkMode` — pure functions mapping capability set → link mode |
| [packages/client/src/terminal-renderer.ts](../../../packages/client/src/terminal-renderer.ts) | `Osc8Features`, `buildLinkMetadata`, `sanitizeConfigString`, `buildOsc8ConfigParam`, `renderGameLink` osc8-send branch, `wordWrap` + `splitPreservingOsc8` |
| [packages/client/src/index.ts](../../../packages/client/src/index.ts) | Re-export `Osc8Features` so the bridge can type call sites without `as` |
| [packages/bridge/tests/new-environ.test.ts](../../../packages/bridge/tests/new-environ.test.ts) | NEW-ENVIRON payload round-trip tests — guards against typos in capability names |
| [packages/bridge/tests/helpers.test.ts](../../../packages/bridge/tests/helpers.test.ts) | `deriveLinkMode` / `nextLinkMode` tests |
| [packages/client/tests/terminal-renderer.test.ts](../../../packages/client/tests/terminal-renderer.test.ts) | `Osc8Features` renderer output, sanitization, word-wrap envelope safety |

## Per-Scheme Tooltip and Menu Contract

`buildLinkMetadata(scheme, cleanTarget, displayText)` decides what appears in the config JSON. Default actions per scheme:

| Scheme  | Tooltip            | Menu entries                                          |
|---------|--------------------|-------------------------------------------------------|
| `go:`   | `Go <dir>`         | `Go` → `send:go <dir>` · `Look` → `send:look <dir>`   |
| `npc:`  | `Talk to <name>`   | `Talk` · `Examine` · separator · `Attack`             |
| `item:` | `Examine <name>`   | `Examine` · `Get` · `Drop`                            |
| `player:` | `Look at <name>` | `Look` · `Tell` → `prompt:tell <name> ` (prompt URI)  |
| `help:` | `Help: <topic>`    | *(none)*                                              |
| `cmd:`  | `<command>`        | *(none)*                                              |

`prompt:` is a Mudlet scheme that inserts text into the client's input line instead of sending immediately — use it for commands that expect a free-form argument.

`-` as a menu entry renders a visual separator in Mudlet's context menu.

## Sanitization Contract

Every string that enters a `?config=` payload must pass through `sanitizeConfigString`, which:

1. Strips all **C0 (0x00–0x1f), C1 (0x80–0x9f), and DEL (0x7f)** bytes. This prevents a hostile NPC display name from smuggling an OSC 8 `ESC \` String Terminator out of the envelope.
2. Truncates to **200 Unicode code points** (via `Array.from`, *not* `.slice` on UTF-16 units). Truncating on UTF-16 units would split a surrogate pair at an emoji and cause `encodeURIComponent` to throw `URIError`.

After serialization, `buildOsc8ConfigParam` wraps `encodeURIComponent(JSON.stringify(config))` in a `try/catch` returning `""` on any failure. On failure the renderer emits a bare `send:<cmd>` URI — degraded but still functional.

## Word-Wrap Invariant

**An OSC 8 envelope must never be split across lines.** The `wordWrap` function uses `splitPreservingOsc8` which treats a complete envelope (opener → closer) as an atomic word. Spaces inside the URI — e.g. `send:talk crier` or `prompt:tell Kandawen ` — would otherwise become wrap points, leaking raw newlines into the URI and producing a clickable no-op.

Consequence: if you add a new URI scheme that contains literal spaces, no extra work is needed — the wrapper already protects it. But if you construct OSC 8 envelopes outside the renderer (don't), you must preserve the envelope atomicity invariant yourself.

Unterminated openers are handled gracefully: `splitPreservingOsc8` logs a `console.warn` and bails out of the "inside-envelope" state so the rest of the line can still wrap.

## Adding a New Capability (Checklist)

Follow this ordered list when adding, say, `OSC_HYPERLINKS_STYLE` or a new MUD-client extension:

1. **Specify the behavior.** What field does it add to `?config=`? What does the client do with it? Link to the upstream spec in a comment.
2. **Add the USERVAR name** to the `NEW-ENVIRON SEND` request list in [telnet.ts](../../../packages/bridge/src/telnet.ts).
3. **Define the renderer feature flag.** Extend `Osc8Features` in [terminal-renderer.ts](../../../packages/client/src/terminal-renderer.ts) and re-export is already in place. Keep the field optional (`?: boolean`) so existing callers don't break.
4. **Implement the metadata.** Extend `buildLinkMetadata` (if per-scheme) or the `buildOsc8ConfigParam` assembly step (if global).
5. **Run everything through `sanitizeConfigString`.** No exceptions. Never inject raw user input into the JSON.
6. **Wire the capability into the bridge.** In `renderAndSend` (bridge.ts) set `osc8Features.<newField> = this.capabilities.has("OSC_HYPERLINKS_<NAME>")` *only* when `mode === "osc8-send"`.
7. **Test at both levels**:
   - Bridge: add a NEW-ENVIRON parsing test in `new-environ.test.ts` that round-trips the capability name. Guards against typos across the pipeline.
   - Client: add a renderer test asserting the `?config=…` payload includes (and excludes) the field based on `Osc8Features`.
8. **Update the features page** (`apps/website/src/pages/features.astro`) and the **bridge wiki** (`Telnet-Bridge.md` → "Mudlet / MUD-client integration" section). Update the AGENTS.md test count if tests were added.
9. **Checkbox** in `PROJECT_PLAN.md` if a roadmap item covers it.

## Common Pitfalls

- **Percent-encoding spaces in `send:` URIs**: the renderer does *not* currently percent-encode spaces (it relies on the word-wrap atomicity invariant instead). Don't "fix" this by replacing spaces with `%20` — Mudlet accepts both forms and the existing tests assert the literal-space form.
- **Empty menu entries**: `{}` as a menu entry would produce `label = undefined` and throw in `.replace()`. `buildOsc8ConfigParam` skips them defensively, but don't rely on that — return `{ Label: "send:cmd" }` or `"-"`, never `{}`.
- **Feature flags without `osc8-send`**: setting `osc8Features.tooltip = true` in `osc8` (host-terminal) mode does nothing — `osc8` uses a dimmed text hint, not a real `send:` URI, so there's nowhere to attach `?config=`. The bridge correctly only populates `osc8Features` when `mode === "osc8-send"`.
- **Writing tests that assert the raw OSC 8 byte sequence**: acceptable and encouraged, but use `\x1b` literals, not the unicode escape forms, so the test file stays portable. Don't try to match across potential line breaks — the word-wrap invariant guarantees envelopes stay on one line.

## Testing

- Run `npx turbo run test --filter=@muddown/bridge --filter=@muddown/client` after any change to this pipeline.
- When adding a new capability, both a bridge-level parsing test and a renderer-level output test are required. A renderer test alone will not catch a typo in the USERVAR name wired into `renderAndSend`.
