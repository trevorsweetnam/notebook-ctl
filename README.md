# Notebook Bridge

Minimal proof-of-concept for reading the live state of open VS Code notebooks from a local CLI.

Repository: `git@github.com:trevorsweetnam/notebook-ctl.git`

## What It Is

- A VS Code extension that inspects notebooks already open in visible notebook editors
- A tiny localhost HTTP server started inside the extension host
- A small CLI, `nbctl`, that talks to that local bridge

Current scope is intentionally narrow:

- `list-open`: list open visible notebook editors
- `inspect`: list cell metadata without full cell bodies
- `list-cells`: alias for `inspect`
- `get`: fetch notebook metadata and full cell source for one open notebook
- `get-cell`: fetch one cell source by numeric index
- `get-outputs`: fetch one cell's outputs by numeric index
- `run-cell`: execute one cell by numeric index
- `run-all`: execute all cells in one open notebook
- `replace-cell`: overwrite one existing cell by numeric index
- `add-cell`: insert one new cell by numeric index
- `delete-cell`: delete one cell by numeric index

This prototype does not use MCP and does not try to sync notebooks to files.

## Requirements

- Node.js 18 or newer
- VS Code 1.90 or newer
- The VS Code `code` CLI on your `PATH`, or `NBCTL_CODE_CLI` pointing at the VS Code CLI executable

On macOS, the default VS Code CLI path is:

```bash
/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code
```

## Installation

Clone the repository:

```bash
git clone git@github.com:trevorsweetnam/notebook-ctl.git
cd notebook-ctl
```

Install the CLI into your local `PATH`:

```bash
npm link
```

Install the bundled VS Code extension:

```bash
nbctl bootstrap
```

If VS Code was already open, reload the VS Code window after bootstrap. Then verify the bridge:

```bash
nbctl doctor
nbctl status
```

## Development Setup

From the repository root:

```bash
npm install
npm test
npm run package:vsix
npm run install:vsix
npm link
```

During development you can run the CLI without linking it globally:

```bash
npm run nbctl -- doctor
```

## Quick Start

1. Install the VS Code extension with `nbctl bootstrap`.
2. Open any `.ipynb` notebook in normal VS Code so it is visible in a notebook editor.
3. From any directory, run:

```bash
nbctl doctor
nbctl status
nbctl list-open
nbctl inspect /absolute/path/to/notebook.ipynb
nbctl get /absolute/path/to/notebook.ipynb
nbctl get file:///absolute/path/to/notebook.ipynb
```

The extension writes bridge state to `~/.notebook-bridge/state.json` and also writes a fallback `.nbctl-state.json` beside the installed extension. The CLI discovers those automatically from any working directory. If needed, override it with `NBCTL_STATE_FILE=/path/to/state.json`.

If `nbctl status` reports `bridge_not_available`, run:

```bash
nbctl bootstrap
nbctl status
```

`bootstrap` installs the bundled VSIX using either `code` on your `PATH` or the standard macOS VS Code CLI path. If the VS Code window was already open, reload it once after bootstrap.

All CLI responses are JSON. Success responses look like:

```json
{
  "ok": true,
  "command": "list-open",
  "data": {
    "notebooks": []
  }
}
```

Failures also return JSON and exit non-zero:

```json
{
  "ok": false,
  "error": {
    "code": "bridge_not_available",
    "message": "Notebook Bridge state file was not found. Run `nbctl bootstrap`, then reload/open VS Code so the extension can start.",
    "details": null
  }
}
```

## Smoke Test

Use `examples/smoke-test.ipynb` as the manual test notebook.

1. In normal VS Code, open `examples/smoke-test.ipynb` and keep it visible in a notebook editor.
2. From any terminal, run `nbctl list-open`.
3. Then run `nbctl get /Users/trevor.sweetnam/Code/notebook-bridge/examples/smoke-test.ipynb`.

Expected result:

- `list-open` returns one entry for `examples/smoke-test.ipynb` if it is the only visible notebook editor.
- `get` returns notebook metadata plus four cells, including markdown, multiline code, and an empty code cell.

## Commands

From any directory once `nbctl` is linked globally:

```bash
nbctl status
nbctl list-open
nbctl inspect /absolute/path/to/notebook.ipynb
nbctl list-cells /absolute/path/to/notebook.ipynb
nbctl get /absolute/path/to/notebook.ipynb
nbctl get-cell /absolute/path/to/notebook.ipynb 1
nbctl get-outputs /absolute/path/to/notebook.ipynb 1
nbctl run-cell /absolute/path/to/notebook.ipynb 1
nbctl run-cell /absolute/path/to/notebook.ipynb 1 --wait --timeout-ms 60000
nbctl run-all /absolute/path/to/notebook.ipynb
nbctl get file:///absolute/path/to/notebook.ipynb
nbctl replace-cell /absolute/path/to/notebook.ipynb 1 --text 'print("updated")'
nbctl replace-cell /absolute/path/to/notebook.ipynb 1 --file /tmp/replacement.py
nbctl add-cell /absolute/path/to/notebook.ipynb 2 --kind code --language python --text 'print("new cell")'
nbctl delete-cell /absolute/path/to/notebook.ipynb 2
nbctl doctor
nbctl bootstrap
```

You can still use `npm run nbctl -- list-open` for local development.

## Read Patterns

Use the lighter read commands first when you do not need the full notebook payload:

- `list-open`: discover which visible notebooks are currently addressable
- `inspect`: inspect cell indexes, kinds, languages, hashes, sizes, and short previews
- `list-cells`: alias for `inspect`
- `get-cell`: fetch one cell source without outputs
- `get-outputs`: fetch one cell's execution summary and outputs
- `run-cell`: trigger execution for one cell, optionally waiting for notebook changes
- `run-all`: trigger execution for the full notebook, optionally waiting for notebook changes
- `get`: fetch the full notebook snapshot

## Replace Cell

`replace-cell` overwrites one existing cell by index in a notebook that is already open in a visible notebook editor.

Behavior:

- matches the notebook by path or `file://` URI
- preserves the cell kind and language
- clears outputs for code cells
- saves the notebook after applying the edit

Example manual test with the smoke notebook:

1. Open `examples/smoke-test.ipynb` in normal VS Code.
2. Run `nbctl get /Users/trevor.sweetnam/Code/notebook-bridge/examples/smoke-test.ipynb` and note the contents of cell `1`.
3. Run `nbctl replace-cell /Users/trevor.sweetnam/Code/notebook-bridge/examples/smoke-test.ipynb 1 --text 'print("bridge write test")'`.
4. Run `nbctl get /Users/trevor.sweetnam/Code/notebook-bridge/examples/smoke-test.ipynb` again to confirm the updated cell source.

## Add And Delete Cells

`add-cell` inserts a new cell at the given numeric index.

Examples:

- `nbctl add-cell /Users/trevor.sweetnam/Code/notebook-bridge/examples/smoke-test.ipynb 1 --kind markdown --text 'Inserted markdown cell'`
- `nbctl add-cell /Users/trevor.sweetnam/Code/notebook-bridge/examples/smoke-test.ipynb 2 --kind code --language python --text 'print("inserted")'`

`delete-cell` removes one cell at the given numeric index.

Examples:

- `nbctl delete-cell /Users/trevor.sweetnam/Code/notebook-bridge/examples/smoke-test.ipynb 2`

## Run Cells

Execution uses VS Code's built-in notebook commands against a notebook that is already open and visible in VS Code.

Examples:

- `nbctl run-cell /Users/trevor.sweetnam/Code/notebook-bridge/examples/smoke-test.ipynb 1`
- `nbctl run-cell /Users/trevor.sweetnam/Code/notebook-bridge/examples/smoke-test.ipynb 1 --wait`
- `nbctl run-all /Users/trevor.sweetnam/Code/notebook-bridge/examples/smoke-test.ipynb --wait --timeout-ms 60000`

Behavior:

- by default, `run-cell` and `run-all` return immediately after dispatching execution
- `--wait` waits for notebook state to change and then returns refreshed data
- `--wait` is best-effort around notebook mutations, not a strict kernel-completion guarantee across every backend

## Notes

- Only notebooks open in visible VS Code notebook editors are exposed.
- `get` accepts either a `file://` URI or a filesystem path. Plain paths are resolved to absolute paths by the CLI.
- `inspect` and `list-cells` target notebook structure, while `get-cell`, `get-outputs`, `run-cell`, `replace-cell`, `add-cell`, and `delete-cell` all target cells by numeric index.
- `add-cell` uses VS Code's insert index semantics: `0` inserts at the top, `cell_count` appends at the end.
- Code-cell writes clear outputs; markdown cells are created with language `markdown`.
- If `nbctl` reports `bridge_not_available`, run `nbctl doctor` and then `nbctl bootstrap`.
- If `nbctl` reports that the bridge is not listening, reload VS Code so the extension starts and writes fresh state.
- Cell execution depends on the notebook's active kernel in VS Code. If no runnable kernel is selected, execution commands may fail or do nothing useful.

## Repository Setup

For a fresh local checkout that is not already connected to GitHub:

```bash
git init
git remote add origin git@github.com:trevorsweetnam/notebook-ctl.git
git branch -M main
git add .
git commit -m "Initial notebook ctl project"
git push -u origin main
```
