#!/usr/bin/env bash
# Nightly release (.github/workflows/release.yml): cuts vYYYY.M.N when main
# has releasable commits since the last tag, with notes grouped into
# Features / Fixes, then dispatches the image build for the new tag.
#
# Skipped as not releasable on their own: docs/chore/ci/test/build/style
# commits, "Release X" commits, and commits that only touch docs, tests or
# CI files.
#
# Env: GH_TOKEN, GITHUB_REPOSITORY, APP_TITLE (release title prefix),
# PUBLISH_WORKFLOW (workflow file that builds a tag's image), DRY_RUN.
set -euo pipefail
: "${APP_TITLE:?}" "${PUBLISH_WORKFLOW:?}" "${GITHUB_REPOSITORY:?}"
DRY_RUN="${DRY_RUN:-false}"

last=$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n1)
range="${last:+$last..}HEAD"

skip_subject='^(docs|chore|ci|test|tests|build|style)(\([^)]*\))?!?:|^Release [0-9]'
skip_path='(\.md$|^docs/|^\.github/|^LICENSE|^test/|^tests/|^screenshots/|^\.gitignore$|^\.editorconfig$)'

features=()
fixes=()
other=()
while IFS= read -r sha; do
  [ -n "$sha" ] || continue
  subject=$(git log -1 --format=%s "$sha")
  if grep -qE "$skip_subject" <<<"$subject"; then continue; fi
  files=$(git diff-tree --no-commit-id --name-only -r "$sha")
  if ! grep -qvE "$skip_path" <<<"$files"; then continue; fi

  text=$(sed -E 's/^[a-z]+(\([^)]*\))?!?: *//' <<<"$subject")
  text="${text^}"
  case "$subject" in
    feat:* | feat\(* | feat!:*) features+=("$text") ;;
    fix:* | fix\(* | fix!:*) fixes+=("$text") ;;
    [a-z]*:* | [a-z]*\(*\):*) other+=("$text") ;;
    # Unprefixed subjects ("Add …", "Fix …") — repos that don't use
    # conventional commits.
    Fix* | Correct* | Stop*) fixes+=("$text") ;;
    *) features+=("$text") ;;
  esac
done < <(git rev-list --reverse --no-merges "$range")

total=$((${#features[@]} + ${#fixes[@]} + ${#other[@]}))
if [ "$total" -eq 0 ]; then
  echo "Nothing releasable since ${last:-the first commit}; no release."
  exit 0
fi

ym=$(TZ=America/Denver date +%Y.%-m)
if [[ "$last" == "v$ym."* ]]; then
  n=$((${last##*.} + 1))
else
  n=1
fi
version="$ym.$n"
tag="v$version"

section() {
  local title=$1
  shift
  [ "$#" -gt 0 ] || return 0
  printf '## %s\n\n' "$title"
  printf -- '- %s\n' "$@"
  printf '\n'
}

notes=$(mktemp)
{
  section "Features" "${features[@]}"
  section "Fixes" "${fixes[@]}"
  section "Other Changes" "${other[@]}"
  printf 'Docker image: `ghcr.io/%s:%s` (also `:stable`)\n' "${GITHUB_REPOSITORY,,}" "$version"
  if [ -n "$last" ]; then
    printf '\n**Full Changelog**: https://github.com/%s/compare/%s...%s\n' "$GITHUB_REPOSITORY" "$last" "$tag"
  fi
} >"$notes"

echo "Release $tag ($total releasable commits since ${last:-the first commit}):"
cat "$notes"

if [ "$DRY_RUN" = "true" ]; then
  echo "Dry run; nothing created."
  exit 0
fi

# A tag created with GITHUB_TOKEN doesn't trigger other workflows' push
# events, so the image build for it is dispatched explicitly.
gh release create "$tag" --repo "$GITHUB_REPOSITORY" --target "$(git rev-parse HEAD)" \
  --title "$APP_TITLE $version" --notes-file "$notes" --latest
gh workflow run "$PUBLISH_WORKFLOW" --repo "$GITHUB_REPOSITORY" --ref "$tag"
