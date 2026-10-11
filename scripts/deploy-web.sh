#!/usr/bin/env bash
# Deploys the web app (apps/web) to Vercel from a clean copy of the repository.
#
#   scripts/deploy-web.sh           a preview deployment
#   scripts/deploy-web.sh --prod    the production deployment
#
# Why a copy: `vercel deploy` run in the working tree uploads files that
# .gitignore lists, `.env` files among them (it did, on 11 October 2026, and a
# key file went up with them). So this copies exactly what git would commit,
# tracked files and new files that are not ignored, into a temporary folder and
# deploys that. A local settings file cannot be uploaded because it is never
# copied. The upload is then read back from Vercel and checked.
#
# Needs: the Vercel CLI signed in, and the project linked once (`vercel link`),
# which leaves `.vercel/project.json` here.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [[ ! -f .vercel/project.json ]]; then
  echo "Not linked to a Vercel project. Run: vercel link" >&2
  exit 1
fi

# The account the project lives in, from the link, so no command has to guess it.
scope="$(grep -Eo '"orgId":"[^"]+"' .vercel/project.json | cut -d'"' -f4)"

export_dir="$(mktemp -d)"
trap 'rm -rf "$export_dir"' EXIT

# Tracked files and untracked files that are not ignored. A tracked file that
# has been deleted here is skipped, not an error.
git ls-files -co --exclude-standard -z \
  | tar --null -T - --ignore-failed-read -cf - 2>/dev/null \
  | tar -xf - -C "$export_dir"
mkdir -p "$export_dir/.vercel"
cp .vercel/project.json "$export_dir/.vercel/"

# Only example files, which hold no values, may be in the copy.
leaked="$(find "$export_dir" -type f -name '.env*' ! -name '.env.example')"
if [[ -n "$leaked" ]]; then
  echo "Refusing to deploy: the copy holds local settings files:" >&2
  echo "$leaked" | sed "s|$export_dir/||" >&2
  exit 1
fi

log="$(mktemp)"
vercel deploy --cwd "$export_dir" --yes --scope "$scope" "$@" 2>&1 | tee "$log"

# Read the upload back and check it, whatever the CLI did with its ignore rules.
url="$(grep -Eo 'https://[a-z0-9.-]+\.vercel\.app' "$log" | tail -1 || true)"
rm -f "$log"
if [[ -z "$url" ]]; then
  echo "Deployed, but the deployment's address was not found in the output, so the upload was not checked." >&2
  exit 1
fi
id="$(vercel api "/v13/deployments/${url#https://}" --scope "$scope" --raw 2>/dev/null | grep -Eo '"id":"dpl_[A-Za-z0-9]+"' | head -1 | cut -d'"' -f4)"
files="$(vercel api "/v6/deployments/$id/files" --scope "$scope" --raw 2>/dev/null || true)"
if [[ -z "$id" || -z "$files" ]]; then
  echo "Deployed to $url, but its file list could not be read, so the upload was not checked." >&2
  exit 1
fi
if echo "$files" | grep -Eo '"name":"\.env[^"]*"' | grep -v '"name":"\.env\.example"' >/dev/null; then
  echo "The deployment at $url holds a local settings file. Remove it now: vercel remove $id --yes --scope $scope" >&2
  exit 1
fi
echo "Deployed to $url. Its upload holds no local settings file."
