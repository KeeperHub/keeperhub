# Agent Instructions

## Package Management

This project uses **pnpm** as its package manager. Always use pnpm for all package operations:

- Installing packages: `pnpm add <package>`
- Running scripts: `pnpm <script-name>`
- **For shadcn/ui components**: Use `pnpm dlx shadcn@latest add <component>` (not `npx`)

Never use npm or yarn for this project.

---

When working on this project, always follow these steps before completing your work:

## 1. Type Check
```bash
pnpm type-check
```
Run TypeScript compiler to check for type errors. Fix any type errors that appear.

## 2. Fix Code
```bash
pnpm fix
```
This will automatically format and lint all code using Ultracite (combines formatting and linting with auto-fixes).

## 3. Fix Issues
If any of the above commands fail or show errors:
- Read the error messages carefully
- Fix the issues in the relevant files
- Re-run the commands to verify fixes
- Repeat until all checks pass

## Important Notes
- Never commit code with type errors or linting issues
- Run `pnpm fix` before making commits to ensure code is properly formatted and linted
- All checks must pass before work is considered complete

## Documentation Guidelines
- **No Emojis**: Do not use emojis in any code, documentation, or README files
- **No File Structure**: Do not include file/folder structure diagrams in README files
- **No Random Documentation**: Do not create markdown documentation files unless explicitly requested by the user. This includes integration guides, feature documentation, or any other .md files

## Component Guidelines
- **Use shadcn/ui**: Always use shadcn/ui components when available. Do not create custom components that duplicate shadcn functionality
- **Add Components**: Use `pnpm dlx shadcn@latest add <component>` to add new shadcn components as needed
- **No Native Dialogs**: Never use native `alert()` or `confirm()` dialogs. Always use shadcn AlertDialog, Dialog, or Sonner toast components instead

## Database Migrations
- **File-based migrations**: production and staging deploys run `pnpm db:migrate` (file-based, `drizzle-kit migrate`), not `db:push`. Migration state is tracked in `drizzle.__drizzle_migrations`. See the "Database Migrations" section in `CLAUDE.md` for the full workflow, journal-timestamp gotcha, and dev-DB bootstrap notes.
- **Standard workflow**:
  1. Update the schema in `lib/db/schema.ts` (or `lib/db/schema-*.ts`)
  2. Run `pnpm drizzle-kit generate` (or `pnpm db:generate`) to produce the migration file. Use `pnpm drizzle-kit generate --custom` to produce an empty file for a hand-written migration when the auto-generator cannot express the change.
  3. Ensure `drizzle/meta/_journal.json` `when` timestamps are monotonically increasing.
  4. Commit migration file, snapshot (if generated), journal, and schema change together.
- **Local dev**: `pnpm db:push` is acceptable for fast iteration on a local dev DB only. Never push schema changes via `db:push` against shared envs.
- **Heavy DDL (`-- @requires-db-prep` directive)**: any migration whose intended production form uses `CREATE INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, or another non-transactional statement must put `-- @requires-db-prep` on the first non-empty line of the SQL file. Write the SQL in its transaction-safe form (plain `CREATE INDEX IF NOT EXISTS` etc.); the directive triggers the `db-prep-check` merge gate which requires an operator to apply the lock-free form against the real target DB manually and flip the matching `db-prepped-<base-branch>` label (`db-prepped-staging`, `db-prepped-prod`). See `CLAUDE.md` "Heavy DDL Migrations" for the operator runbook and the rationale.

## Code Cleanliness
- **Remove Unused Code**: If a variable, import, or function is unused, remove it entirely. Do not prefix with underscore unless it's intentionally unused but required (e.g., function parameters)
- **Use Correct Jotai Hooks**: When working with Jotai atoms, use the appropriate hook based on usage:
  - `useAtom(atom)` - Use when you need both the value and setter
  - `useAtomValue(atom)` - Use when you only need to read the value
  - `useSetAtom(atom)` - Use when you only need the setter function
  - Never use `useAtom` if you're only using one part (getter or setter)

## API Architecture
- **Use API Routes**: This project uses API routes instead of Next.js server actions
- **API Client**: Always use the type-safe API client from `@/lib/api-client` for all backend calls
- **No Server Actions**: Do not create or use server actions (files with `"use server"` directive)
- **Import Pattern**: Import the API client as `import { api } from "@/lib/api-client"`
- **Available APIs**:
  - `api.ai.*` - AI operations (generate workflows)
  - `api.integration.*` - Test integration connections
  - `api.user.*` - User operations (get, update)
  - `api.workflow.*` - Workflow CRUD and operations (create, update, delete, deploy, execute, etc.)
- **No Barrel Files**: Do not create barrel/index files that re-export from other files

## Plugin Guidelines
- **No SDK Dependencies**: Plugin step files must use `fetch` directly instead of SDK client libraries. Do not add npm package dependencies for API integrations.
- **No dependencies field**: Do not use the `dependencies` field in plugin `index.ts` files. All API calls should use native `fetch`.
- **Why**: Using `fetch` instead of SDKs reduces supply chain attack surface. SDKs have transitive dependencies that could be compromised.

