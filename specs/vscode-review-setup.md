# VS Code Review Annotation Setup

Two-step setup to enable inline annotations on Claude Code plans and responses.

## 1. Markdown Snippet

**Cmd+Shift+P** > "Snippets: Configure Snippets" > select **Markdown**

Add to `markdown.json`:

```json
"Annotate Selection": {
  "prefix": "annotate",
  "body": ["<!-- COMMENT", "> ${TM_SELECTED_TEXT}", "", "$1", "-->$0"]
}
```

## 2. Keyboard Shortcut

**Cmd+Shift+P** > "Preferences: Open Keyboard Shortcuts (JSON)"

Add to `keybindings.json`:

```json
{
  "key": "ctrl+shift+a",
  "command": "editor.action.insertSnippet",
  "args": { "name": "Annotate Selection" },
  "when": "editorTextFocus && editorLangId == markdown"
}
```

## Usage

1. Select text in any `.md` file
2. Press **Ctrl+Shift+A**
3. Type your feedback inside the comment block
4. Save the file

Works with `/review-plan` (structured review) and any markdown file Claude opens.
