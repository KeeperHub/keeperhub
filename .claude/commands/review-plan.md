---
description: Review the last response in your editor -- leave inline comments, save, and discuss
allowed-tools: Bash, Read, Write
---

You are running an interactive review loop. Follow these steps exactly:

## Step 1: Extract and format

Take your **most recent assistant message** from this conversation (the last substantial response you gave before this command was invoked). Reformat it into a reviewable document with the following structure:

- Keep all original content intact (headings, tables, code blocks, lists)
- After each major section (H2, H3, or significant paragraph/table), insert a comment block:

```
<!-- COMMENT: section-name -->


<!-- /COMMENT -->
```

- At the top of the file, add:

```
# Review: [title derived from the response]
# Instructions: Add your notes inside the COMMENT blocks.
# Save and close the file when done. Leave COMMENT blocks empty to skip.
# TIP: Select text and press Ctrl+Shift+A to add inline annotations anywhere.
```

- At the bottom, add:

```
<!-- COMMENT: overall -->


<!-- /COMMENT -->
```

Write this to `/tmp/claude-review.md`.

## Step 2: Open in editor

Open the file in VS Code and wait for the tab to close:

```bash
code --wait /tmp/claude-review.md
```

This will block until the user saves and closes the tab in VS Code.

## Step 3: Read back and respond

After the editor closes, read `/tmp/claude-review.md`. Parse all `<!-- COMMENT: ... -->` blocks.

For each non-empty comment (where the user wrote feedback between the comment tags):
- Quote the section it refers to
- Respond directly to the user's comment
- If the comment is a question, answer it
- If the comment is feedback or a direction, acknowledge it and explain how you'd act on it
- If the comment is a disagreement, engage with the argument

Ignore empty or unchanged placeholder comments.

## Step 4: Ask to continue

After responding to all comments, ask if the user wants to:
1. **Re-review** -- update the file with your responses and open the editor again for another round
2. **Save findings** -- write the reviewed analysis to a permanent location
3. **Act on it** -- start implementing any action items that emerged
4. **Done** -- end the review loop

If the user picks (1), repeat from Step 1 but incorporate both the original content and the discussion so far.
