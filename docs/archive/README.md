# docs/archive — MVP-era design history (read-only)

Archived 2026-07-22 when the MVP was declared complete. The living source of truth is now **`docs/PROJECT.md`**; these files keep the full design rationale, stage-by-stage verification notes, and the original decision log. Don't edit them except to fix a broken pointer — new decisions go in PROJECT.md §14.

**Code comments across the repo still cite "BACKBONE §N" — those citations remain valid and point into `BACKBONE.md` here.** Leave them as-is; new code should cite PROJECT.md sections instead.

| File | What it was |
|---|---|
| `BACKBONE.md` | The MVP design source of truth. §5 DDL, §6 API sketch, §7 media pipeline, §8 WS/push, §9 UI checklist, §11 call invariants, §12 roadmap, §13 icebox, §14 stage-by-stage build log, **§15 decision log (2026-07-17 → 2026-07-22, ~60 entries — the most valuable part; consult before re-litigating oddities)** |
| `STAGE0.md` | Stage 0 risk-retirement status/handoff (push PoC, voice PoC, scaffold) |
| `UI_REVAMP.md` | UI-1…UI-7 revamp plan + per-stage implementation notes (design tokens, desktop layout, masonry, MediaViewer gestures) |
| `UI8_CHAT_INSTAGRAM.md` | UI-8 chat interaction pass spec (focus menu, run corners, dividers, recording UX) |
| `MESSAGE_DELETE.md` | Message deletion + multi-select implementation plan (§2 item 11) |

Rough mapping of the most-cited BACKBONE sections → PROJECT.md: §2 scope → §1 · §3 stack → §2 · §5 schema → §5 · §6 API → §6 · §7 media → §8 · §8 WS/push → §7/§9 · §9 UI → §11/§12 · §11 calls → §15 · §12/§13 roadmap/icebox → §13 · §15 decisions → §14.
