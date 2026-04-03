# CI/CD Design

**Goal:** Add a GitHub Actions workflow that runs type checking and tests on every push to main and on pull requests, ensuring code quality is maintained as the project grows.

**Architecture:** A single GitHub Actions workflow file (`.github/workflows/ci.yml`) that runs `tsc --noEmit` for type checking and `vitest run` for tests across Node.js 18 and 22.

**Tech Stack:** GitHub Actions, Node.js 18/22 matrix, npm.

---

## Workflow

**File:** `.github/workflows/ci.yml`

**Triggers:**
- Push to `main` branch
- Pull requests targeting `main` branch

**Matrix:** Node.js 18 (minimum supported) and 22 (current LTS).

**Steps:**
1. Checkout code
2. Set up Node.js (from matrix)
3. Install dependencies (`npm ci`)
4. Type check (`npx tsc --noEmit`)
5. Run tests (`npx vitest run`)

## Design Decisions

- **Node 18 + 22 matrix:** README states "Node.js 18+" as a requirement. Testing both the minimum and current LTS ensures compatibility. Node 20 is skipped — if 18 and 22 pass, 20 will too.
- **`npm ci` over `npm install`:** Clean installs from lockfile, faster and deterministic in CI.
- **Type check as a separate step:** Catches type errors that vitest might not surface (vitest uses esbuild which skips type checking).
- **No caching:** npm caching adds complexity for marginal gains on a small project. Can add later if CI times grow.
- **No Docker build step:** Docker image is a separate future feature.
- **No deployment step:** This is a library/server, not a hosted service.
- **No branch protection rules:** Those are configured in GitHub settings, not in the workflow file. Recommend enabling "Require status checks" for the CI job after the workflow is merged.

## What This Catches

- Type errors introduced by PRs
- Test regressions
- Node.js version compatibility issues
- Missing or broken dependencies
