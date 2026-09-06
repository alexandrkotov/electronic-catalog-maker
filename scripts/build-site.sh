#!/usr/bin/env bash
# Assembles the published site (landing page + editor + viewer + demo
# catalogs) into ./site, ready to be served by any static host.
#
# This is the single source of truth for "how the site is put together" —
# used by GitHub Actions (.github/workflows/ci.yml, deploy-pages job) and
# by RECOVERY.md's disaster-recovery instructions (a Cloudflare Pages
# build command pointed at a mirror of this repo, if github.com itself is
# ever unavailable). Keeping this in one script means both paths build
# the exact same site instead of two copies of the same steps drifting
# apart.
#
# Assumes `pnpm install` has already run. Usage: bash scripts/build-site.sh

set -euo pipefail
cd "$(dirname "$0")/.."

pnpm --filter @ecm/editor build
pnpm --filter @ecm/viewer build

rm -rf site
mkdir -p site
cp landing/index.html site/index.html
cp landing/privacy.html site/privacy.html
cp -r packages/editor/dist site/editor
cp -r packages/viewer/dist site/viewer
cp -r demo site/demo

echo "Site assembled in ./site"
