#!/bin/bash
# Pre-Edit hook: Inject lint rules before Edit/Write operations
# This makes lint rules salient in Claude's context before code changes

set -e

# Read JSON input
INPUT=$(cat)

# Extract file path being edited
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ]; then
    exit 0
fi

# Only inject rules for TypeScript/JavaScript files
case "$FILE_PATH" in
    *.ts|*.tsx|*.js|*.jsx)
        ;;
    *)
        exit 0
        ;;
esac

# Build lint context reminder
LINT_CONTEXT="## Ultracite/Biome Lint Rules (apply to this edit)

**Type Safety:**
- Use explicit types for function parameters and return values
- Prefer \`unknown\` over \`any\` - if you must use \`any\`, add a biome-ignore comment explaining why
- Use const assertions (\`as const\`) for immutable values

**Modern JS/TS:**
- Use \`for...of\` loops, not \`.forEach()\` or indexed loops
- Use optional chaining (\`?.\`) and nullish coalescing (\`??\`)
- Use \`const\` by default, \`let\` only when reassignment needed
- Use template literals over string concatenation
- Use destructuring for object/array assignments

**React/JSX:**
- Use function components, not class components
- Call hooks at top level only, never conditionally
- Specify all dependencies in hook dependency arrays
- Use \`key\` prop for elements in iterables (prefer unique IDs over indices)
- Use semantic HTML elements (\`<button>\`, \`<nav>\`) not divs with roles

**Next.js:**
- Use Next.js \`<Image>\` component, not \`<img>\`
- Use Server Components for async data fetching

**Async:**
- Always \`await\` promises in async functions
- Use async/await over promise chains

**Clean Code:**
- Remove \`console.log\`, \`debugger\`, \`alert\` from production code
- Add \`rel=\"noopener\"\` when using \`target=\"_blank\"\"
- Prefer early returns to reduce nesting

**Lint Ignores:**
- Only use biome-ignore when absolutely necessary
- Always specify the exact rule and add explanation
- Example: \`// biome-ignore lint/suspicious/noExplicitAny: SDK types incomplete\`"

# Output JSON with additionalContext
cat << EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": $(echo "$LINT_CONTEXT" | jq -Rs .)
  }
}
EOF

exit 0
