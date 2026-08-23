# DESIGN-101 design-system primitive local evidence

Date: 2026-08-23
Source SHA: `9764f41` plus current dirty worktree changes
Boundary: UI primitive implementation and local component regression evidence; no hosted CI or
manual visual/accessibility sign-off.

## Implemented

- Added and barrel-exported `Modal`, `Table`, `Tabs` and `Tooltip` primitives.
- Reused the existing Tailwind v4 cosmic token palette, shadcn-flavored component conventions,
  `cn()` class composition and existing button/card interaction language.
- Included modal Escape/backdrop/footer behavior, table loading/empty states, tab counts and
  selection events, and keyboard-focus-visible tooltip behavior in the component contracts.
- Added component tests for all four primitives.

## Local evidence

- UI typecheck (`pnpm type-check`, `vue-tsc --noEmit`) — exit 0.
- Full UI test lane — exit 0, 29 files / 136 tests.
- UI production build (`pnpm --filter @spa/ui build`) — exit 0. The build warning
  for invalid `.ui-table:hoverable` CSS was fixed by using the intended class
  selector `.ui-table.hoverable`.
- Scoped primitive formatting (`oxfmt --check` on 8 primitive/source-test files) — exit 0.
- UI barrel exports include all four primitives.

## Remaining gate

- Manual visual/accessibility review, hosted CI first-green evidence and clean whole-worktree
  formatting remain `VERIFY`. The repository-wide format check also reports unrelated dirty
  backend/parallel files outside DESIGN-101 and is not claimed as this slice's PASS_LOCAL.
