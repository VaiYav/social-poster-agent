# ACCOUNT-102 local evidence snapshot

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus current dirty worktree changes  
Boundary: local source/mock/unit acceptance only; no real two-account Redis/Postgres, staging, production or manual platform session evidence.

## Local acceptance coverage

- Account selection and round-robin generation assignment are covered in AccountsService and
  GenerationService tests.
- Account-bound session, posting, warm-up, queue payload and continuation paths preserve account id.
- Browser isolation includes separate same-network Facebook persistent profile paths for two account
  ids (`browser.factory.spec.ts`, 41 tests).
- Queue depth and rate-limit WorldState snapshots remain separate for two same-network accounts;
  autonomous generation excludes an account with exhausted capacity.
- Account settings resolver/API/UI and active-switch synchronization are locally verified.

## Evidence

- Existing account-isolation lane — exit 0, 19 files / 408 tests.
- Browser same-network isolation lane — exit 0, 1 file / 41 tests.
- Current broad backend lane before later EVAL-only additions — exit 0, 149 files / 1,878 tests
  excluding only the independent QuoteCard render file.
- Backend typecheck, shared build, UI full suite/typecheck/build and owned lint/format checks — exit 0
  in the corresponding local evidence artifacts.

## Not proven

`ACCOUNT-102` remains `VERIFY`: real same-network accounts, Redis/Postgres concurrency, browser
storage/fingerprint behavior on the target platforms, staging/production and manual operator
acceptance remain open.
