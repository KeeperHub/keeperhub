#!/bin/bash
# Pre-commit hook for Claude Code
# Runs lint and type-check before git commit commands
# Saves output to .claude/*.txt for Claude to read without re-running
# Exit code 2 blocks the commit, exit code 0 allows it

set -e

# Read JSON input from stdin
INPUT=$(cat)

# Extract the command being run
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only process git commit commands
if ! echo "$COMMAND" | grep -q "git commit"; then
    exit 0
fi

# Get the project directory
PROJECT_DIR=$(echo "$INPUT" | jq -r '.cwd // empty')
if [ -z "$PROJECT_DIR" ]; then
    PROJECT_DIR="$CLAUDE_PROJECT_DIR"
fi

# Only run pnpm checks when committing within the keeperhub project.
# Extract the first cd path from the command (handles `cd "/path" && git commit` patterns).
KEEPERHUB_DIR="$CLAUDE_PROJECT_DIR"

# Extract path after first `cd "` using bash string manipulation
AFTER_CD="${COMMAND#*cd \"}"
if [ "$AFTER_CD" != "$COMMAND" ]; then
    CMD_CWD="${AFTER_CD%%\"*}"
else
    CMD_CWD=""
fi

# Fallback to PROJECT_DIR if no cd path found
COMMIT_DIR="${CMD_CWD:-$PROJECT_DIR}"

if [[ "$COMMIT_DIR" != "$KEEPERHUB_DIR"* ]]; then
    exit 0
fi

cd "$KEEPERHUB_DIR"

# Ensure .claude directory exists
mkdir -p .claude

echo "Running pre-commit checks..." >&2

# Run lint check and save output
echo "Checking lint (pnpm check)..." >&2
LINT_EXIT=0
LINT_OUTPUT=$(pnpm check 2>&1) || LINT_EXIT=$?
echo "$LINT_OUTPUT" > .claude/lint-output.txt
echo "Lint output saved to .claude/lint-output.txt" >&2

if [ "$LINT_EXIT" -ne 0 ]; then
    echo "" >&2
    echo "COMMIT BLOCKED: Lint check failed." >&2
    echo "Read .claude/lint-output.txt for errors, or run 'pnpm fix' to auto-fix." >&2
    exit 2
fi

# Run type check and save output
echo "Checking types (pnpm type-check)..." >&2
TYPE_OUTPUT=$(pnpm type-check 2>&1) || true
echo "$TYPE_OUTPUT" > .claude/typecheck-output.txt
echo "Type check output saved to .claude/typecheck-output.txt" >&2

if echo "$TYPE_OUTPUT" | grep -q "error TS"; then
    echo "" >&2
    echo "COMMIT BLOCKED: Type check failed." >&2
    echo "Read .claude/typecheck-output.txt for errors." >&2
    exit 2
fi

echo "All pre-commit checks passed." >&2
exit 0
