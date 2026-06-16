# Nimpackages

Static website listing all Nim packages from the [nim-lang/packages](https://github.com/nim-lang/packages) registry. Deployed to AWS Amplify.

## Build

The build script fetches `packages.json`, enriches each package with its latest version tag and last updated date via the GitHub GraphQL API (batched), then emits a single `dist/index.html` with all data and search logic inlined.

### Prerequisites

```bash
npm install
```

A GitHub personal access token is required for enriching the ~2,700 GitHub-hosted packages. Without it, version and last-updated data will be missing for those packages.

Create a token at [github.com/settings/tokens](https://github.com/settings/tokens) — read-only public repo access is sufficient.

```bash
export GITHUB_TOKEN=ghp_...
```

### Run the build

```bash
npm run build
```

Output is written to `dist/index.html`. On subsequent local runs, `packages.json` is cached in the project root to avoid re-downloading (excluded from git via `.gitignore`). Set `NODE_ENV=production` to force a fresh download.

## Local dev server

```bash
npx serve dist -p 3000
```

Then open [http://localhost:3000](http://localhost:3000).

## Amplify deployment

Add the following environment variables in the Amplify Console (App settings → Environment variables):

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | Yes | GitHub PAT for GraphQL enrichment (public repo read access) |
| `GITLAB_TOKEN` | No | GitLab token for GitLab-hosted packages |
| `CODEBERG_TOKEN` | No | Codeberg token for Codeberg-hosted packages |
| `TRACKING_SCRIPT_URL` | No | Analytics script URL (e.g. `https://stats.example.com/script.js`) |
| `TRACKING_WEBSITE_ID` | No | Analytics website ID injected as `data-website-id` |

Both `TRACKING_SCRIPT_URL` and `TRACKING_WEBSITE_ID` must be set for the analytics script to be injected. The `amplify.yml` handles the build automatically on each push.
