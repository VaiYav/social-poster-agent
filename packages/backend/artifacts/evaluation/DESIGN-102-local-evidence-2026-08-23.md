# DESIGN-102 view primitive adoption local evidence

Date: 2026-08-23  
Source SHA: `74a1e7cc5e32bb90453f2809876f840724cc6a24` plus current dirty worktree changes  
Boundary: UI primitive adoption and local regression evidence; no manual visual/accessibility
sign-off.

## Implemented

- Queue's `PostEditor` now composes the shared `Modal` primitive and preserves the existing
  `save(id, editedContent)` / `close` contract.
- Calendar's reschedule overlay uses `Modal`; Analytics' conversion table uses `Table`.
- Queue, Dashboard and Monitor were audited for native/ad-hoc tables/dialogs; none remain to
  replace in those views. ReviewFeedbackDialog intentionally uses native `<dialog>` for its
  focus/backdrop behavior rather than duplicating a custom overlay.
- Fixed duplicate close emission in `PostEditor` caused by listening to both Modal close events.

## Local evidence

- UI typecheck (`pnpm type-check`, vue-tsc) — exit 0.
- Full UI test lane — exit 0, 29 files / 136 tests.
- Scoped formatting (`oxfmt --check`) for PostEditor, its tests and adopted views — exit 0.
- Static UI scan confirms no `<table>`/`<dialog>`/custom overlay remains in Queue, Dashboard or
  Monitor; adopted table/modal usages are present in Analytics/Calendar/PostEditor.

## Remaining gate

- Manual visual/accessibility review and global workspace format remain `VERIFY`; unrelated dirty
  backend/parallel files are outside this UI slice.
