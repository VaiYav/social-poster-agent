# Contributing to Social Poster Agent

Thanks for your interest in contributing! This project is a domain-agnostic, AI-assisted multi-network social posting system. These guidelines help keep the codebase maintainable and welcoming for everyone.

## Quick start

1. Fork and clone the repo.
2. Install dependencies:
   ```bash
   corepack enable
   pnpm install
   ```
3. Copy and fill in the environment file:
   ```bash
   cp .env.example .env
   ```
4. Copy the example brand voice to `brand-voice.md`:
   ```bash
   cp brand-voice.example.md brand-voice.md
   ```
5. Start the dev stack:
   ```bash
   pnpm infra:up
   pnpm dev:all
   ```

## Pull request process

- Branch from `main` (or the current active feature branch for large changes).
- Keep PRs focused on one concern.
- Add or update tests for changed behavior.
- Run verification before pushing:
  ```bash
  cd packages/backend
  npx tsc --noEmit
  cd ../..
  pnpm lint
  pnpm --filter @spa/backend test:unit
  ```
- Use clear commit messages that describe *why* the change was made.

## Project structure

- `packages/shared` — Zod schemas and shared domain types.
- `packages/backend` — NestJS 11 backend with hexagonal ports/adapters.
- `packages/ui` — Vue 3 + Vite + Pinia frontend.

## Coding conventions

- Prefer explicit, simple code. Avoid clever meta-programming.
- Use the existing DI token pattern in the backend (`@Inject(ILlmPort)`, etc.).
- Do not hardcode secrets, tokens, or PII.
- Avoid `any` without justification.
- Match existing formatting. The repo uses `oxlint` and `oxfmt`.

## Reporting issues

Open an issue with:
- A clear description of the bug or feature.
- Steps to reproduce (for bugs).
- The command/output that failed.
- Your Node.js and pnpm versions.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
