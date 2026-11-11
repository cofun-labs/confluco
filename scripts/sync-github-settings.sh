#!/usr/bin/env bash
# Apply the repository's GitHub settings from the files in this repo.
#
# Run by a repository admin with the gh CLI signed in:
#   scripts/sync-github-settings.sh [owner/repo]
#
# Idempotent: it reads the current settings, changes only what differs,
# and prints what it changed.

set -euo pipefail

cd "$(dirname "$0")/.."

repo="${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
api="repos/$repo"

changed() { echo "changed:   $1"; }
unchanged() { echo "unchanged: $1"; }

# Keep only the parts of a live object that the desired object also has, so
# fields GitHub adds with default values don't count as differences.
project='
def project($d):
  if ($d | type) == "object" and type == "object" then
    with_entries(.key as $k | select($d | has($k)) | .value |= project($d[$k]))
  elif ($d | type) == "array" and type == "array" and length == ($d | length) then
    [range(length) as $i | .[$i] | project($d[$i])]
  else . end;
'

# --- Rulesets ---------------------------------------------------------------

for file in .github/rulesets/*.json; do
  name="$(jq -r .name "$file")"
  id="$(gh api "$api/rulesets?includes_parents=false" --jq ".[] | select(.name == \"$name\") | .id")"

  if [ -z "$id" ]; then
    gh api -X POST "$api/rulesets" --input "$file" >/dev/null
    changed "ruleset '$name' (created)"
    continue
  fi

  # Sort rules by type so the order GitHub returns them in doesn't matter.
  want="$(jq -S '.rules |= sort_by(.type)' "$file")"
  live="$(gh api "$api/rulesets/$id" |
    jq -S --argjson d "$want" "$project"' .rules |= sort_by(.type) | project($d)')"
  if [ "$live" = "$want" ]; then
    unchanged "ruleset '$name'"
  else
    gh api -X PUT "$api/rulesets/$id" --input "$file" >/dev/null
    changed "ruleset '$name' (updated)"
    diff <(echo "$live") <(echo "$want") | sed 's/^/  /' || true
  fi
done

# --- Repository options -----------------------------------------------------

repo_json="$(gh api "$api")"

# Squash merge only, with the PR title and body as the commit message, and
# delete head branches once merged. Auto-merge is allowed because `gh pr merge`
# needs it to add a PR to the merge queue.
want_options='{
  "allow_squash_merge": true,
  "allow_merge_commit": false,
  "allow_rebase_merge": false,
  "squash_merge_commit_title": "PR_TITLE",
  "squash_merge_commit_message": "PR_BODY",
  "delete_branch_on_merge": true,
  "allow_auto_merge": true
}'
options_diff="$(jq -n --argjson live "$repo_json" --argjson want "$want_options" \
  '$want | with_entries(select($live[.key] != .value))')"
# GitHub accepts the squash commit title and message only as a pair.
if jq -e 'has("squash_merge_commit_title") or has("squash_merge_commit_message")' <<<"$options_diff" >/dev/null; then
  options_diff="$(jq --argjson want "$want_options" \
    '. + {squash_merge_commit_title: $want.squash_merge_commit_title, squash_merge_commit_message: $want.squash_merge_commit_message}' <<<"$options_diff")"
fi
if [ "$options_diff" = "{}" ]; then
  unchanged "merge options"
else
  gh api -X PATCH "$api" --input - <<<"$options_diff" >/dev/null
  jq -r 'to_entries[] | "changed:   \(.key) = \(.value)"' <<<"$options_diff"
fi

for feature in secret_scanning secret_scanning_push_protection; do
  status="$(jq -r ".security_and_analysis.$feature.status" <<<"$repo_json")"
  if [ "$status" = "enabled" ]; then
    unchanged "$feature"
  else
    jq -n --arg f "$feature" '{security_and_analysis: {($f): {status: "enabled"}}}' |
      gh api -X PATCH "$api" --input - >/dev/null
    changed "$feature (enabled)"
  fi
done

# Dependabot security updates need vulnerability alerts turned on first.
if gh api "$api/vulnerability-alerts" --silent 2>/dev/null; then
  unchanged "Dependabot alerts"
else
  gh api -X PUT "$api/vulnerability-alerts" --silent
  changed "Dependabot alerts (enabled)"
fi

if [ "$(gh api "$api/automated-security-fixes" --jq .enabled)" = "true" ]; then
  unchanged "Dependabot security updates"
else
  gh api -X PUT "$api/automated-security-fixes" --silent
  changed "Dependabot security updates (enabled)"
fi
