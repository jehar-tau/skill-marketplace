# Working on this project

- **Branches:** `dev` is where work lands, `staging` is the rehearsal, `main` is what real users run. See [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md).
- **Every change is a pull request.** Branch from `dev`, keep the change small, and say in the description how you checked it.
- **Before opening one:** `pnpm typecheck` and `pnpm test` must pass. If you touched how text is understood, run `pnpm eval` too.
- **Database changes** are new numbered files in `packages/core/migrations/`. Never edit a migration that has already run anywhere.
- **New settings** go in `.env.example` with a one-line explanation, and in the table in `docs/ENVIRONMENTS.md` if they differ per environment.
- **Secrets never go in the repository.** Not in code, not in docs, not in tests.
- **Privacy rules are tests.** The checks in `packages/core/test/flow.test.ts` under "privacy boundaries" must keep passing; add to them when you add a way to read someone's data.
