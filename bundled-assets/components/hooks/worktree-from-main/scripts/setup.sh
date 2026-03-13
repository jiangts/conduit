#!/usr/bin/env bash
set -euo pipefail

repo_path="${CONDUIT_PROJECT_PATH:?CONDUIT_PROJECT_PATH is required}"
run_id="${CONDUIT_RUN_ID:-run}"
attempt_index="${CONDUIT_ATTEMPT_INDEX:-0}"
hook_output_path="${CONDUIT_HOOK_OUTPUT_PATH:-}"

resolve_ref() {
  if [[ -n "${CONDUIT_BASELINE_REF:-}" ]]; then
    printf '%s\n' "$CONDUIT_BASELINE_REF"
    return 0
  fi

  local candidate
  for candidate in origin/main main origin/master master; do
    if git -C "$repo_path" rev-parse --verify --quiet "$candidate" >/dev/null; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  git -C "$repo_path" rev-parse HEAD
}

ref="$(resolve_ref)"
worktrees_root="$repo_path/.conduit/worktrees/$run_id"
workspace_path="$worktrees_root/attempt-$attempt_index"

mkdir -p "$worktrees_root"

if [[ -e "$workspace_path" ]]; then
  git -C "$repo_path" worktree remove --force "$workspace_path" >/dev/null 2>&1 || rm -rf "$workspace_path"
fi

git -C "$repo_path" worktree add --detach "$workspace_path" "$ref" >/dev/null

if [[ -n "$hook_output_path" ]]; then
  mkdir -p "$(dirname "$hook_output_path")"
  node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({workspace_path: process.argv[2]}) + "\n");' "$hook_output_path" "$workspace_path"
fi
