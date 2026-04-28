const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vscode = require("vscode");
const { summarizeCell } = require("./lib/notebook-inspection");

function stateFilePath() {
  return path.join(os.homedir(), ".notebook-bridge", "state.json");
}

function workspaceStateFilePath() {
  return path.join(__dirname, ".nbctl-state.json");
}

function stateFilePaths() {
  return [stateFilePath(), workspaceStateFilePath()];
}

function writeStateFiles(state, outputChannel) {
  const written = [];
  for (const filePath of stateFilePaths()) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
      written.push(filePath);
    } catch (error) {
      outputChannel.appendLine(`Failed to write state file at ${filePath}: ${error.message}`);
    }
  }

  if (written.length === 0) {
    throw new Error("Notebook Bridge could not write any state files.");
  }

  return written;
}

function getVisibleNotebookEditors() {
  return vscode.window.visibleNotebookEditors;
}

function decodeOutputItemData(item) {
  const mime = item.mime;
  const bytes = Buffer.from(item.data);

  if (mime.startsWith("text/") || mime === "application/x.notebook.stdout" || mime === "application/x.notebook.stderr") {
    return {
      mime,
      format: "text",
      text: bytes.toString("utf8")
    };
  }

  if (mime.includes("json") || mime.endsWith("+json") || mime === "application/vnd.code.notebook.error") {
    const text = bytes.toString("utf8");
    try {
      return {
        mime,
        format: "json",
        json: JSON.parse(text)
      };
    } catch (error) {
      return {
        mime,
        format: "text",
        text
      };
    }
  }

  if (mime.startsWith("image/")) {
    return {
      mime,
      format: "base64",
      base64: bytes.toString("base64")
    };
  }

  return {
    mime,
    format: "base64",
    base64: bytes.toString("base64")
  };
}

function toOutputInfo(output, index) {
  return {
    index,
    items: output.items.map(decodeOutputItemData),
    metadata: output.metadata || {}
  };
}

function outputByteLength(output) {
  return output.items.reduce((total, item) => total + Buffer.from(item.data).length, 0);
}

function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function summarizeOutputItem(item) {
  const decoded = decodeOutputItemData(item);
  if (decoded.format === "text") {
    return {
      mime: decoded.mime,
      format: decoded.format,
      text_preview: decoded.text.slice(0, 200)
    };
  }

  if (decoded.format === "json") {
    return {
      mime: decoded.mime,
      format: decoded.format,
      json_preview: JSON.stringify(decoded.json).slice(0, 200)
    };
  }

  return {
    mime: decoded.mime,
    format: decoded.format,
    data_preview: decoded.base64.slice(0, 200)
  };
}

function toExecutionSummary(cell) {
  const summary = cell.executionSummary;
  if (!summary) {
    return null;
  }

  return {
    execution_order: summary.executionOrder ?? null,
    success: summary.success ?? null,
    timing: summary.timing
      ? {
          start_time: summary.timing.startTime,
          end_time: summary.timing.endTime
        }
      : null
  };
}

function toCellInfo(cell, index) {
  return {
    id: `c${index}`,
    index,
    kind: cell.kind === vscode.NotebookCellKind.Markup ? "markdown" : "code",
    language: cell.document.languageId,
    source: cell.document.getText(),
    execution_summary: toExecutionSummary(cell),
    outputs: cell.outputs.map(toOutputInfo)
  };
}

function toCellSourceInfo(cell, index) {
  return {
    id: `c${index}`,
    index,
    kind: cell.kind === vscode.NotebookCellKind.Markup ? "markdown" : "code",
    language: cell.document.languageId,
    source: cell.document.getText(),
    execution_summary: toExecutionSummary(cell)
  };
}

function toCellOutputsInfo(cell, index) {
  return {
    id: `c${index}`,
    index,
    kind: cell.kind === vscode.NotebookCellKind.Markup ? "markdown" : "code",
    language: cell.document.languageId,
    execution_summary: toExecutionSummary(cell),
    outputs: cell.outputs.map(toOutputInfo)
  };
}

function toNotebookSummary(editor) {
  const notebook = editor.notebook;
  return {
    notebook_uri: notebook.uri.toString(),
    file_path: notebook.uri.fsPath,
    notebook_type: notebook.notebookType,
    cell_count: notebook.cellCount,
    is_active: vscode.window.activeNotebookEditor?.notebook.uri.toString() === notebook.uri.toString(),
    is_visible: true
  };
}

function toNotebookDetail(editor) {
  const notebook = editor.notebook;
  const cells = [];
  for (let index = 0; index < notebook.cellCount; index += 1) {
    cells.push(toCellInfo(notebook.cellAt(index), index));
  }

  return {
    notebook_uri: notebook.uri.toString(),
    file_path: notebook.uri.fsPath,
    notebook_type: notebook.notebookType,
    cell_count: notebook.cellCount,
    cells
  };
}

function toNotebookInspection(editor) {
  const notebook = editor.notebook;
  const cells = [];
  let totalSourceLength = 0;
  let totalOutputBytes = 0;

  for (let index = 0; index < notebook.cellCount; index += 1) {
    const cell = notebook.cellAt(index);
    const item = toCellListItem(cell, index);
    cells.push(item);
    totalSourceLength += item.source_length;
    totalOutputBytes += item.output_bytes;
  }

  return {
    notebook_uri: notebook.uri.toString(),
    file_path: notebook.uri.fsPath,
    notebook_type: notebook.notebookType,
    cell_count: notebook.cellCount,
    total_source_length: totalSourceLength,
    total_output_bytes: totalOutputBytes,
    cells
  };
}

function toCellListItem(cell, index) {
  return summarizeCell(
    cell,
    index,
    cell.kind === vscode.NotebookCellKind.Markup ? "markdown" : "code"
  );
}

function toCellDetail(cell, index) {
  return toCellSourceInfo(cell, index);
}

function toCellOutputsDetail(cell, index) {
  return toCellOutputsInfo(cell, index);
}

function findOpenNotebook(targets) {
  const normalizedTargets = []
    .concat(targets || [])
    .filter(Boolean)
    .map((target) => String(target));

  return getVisibleNotebookEditors().find((editor) => {
    const uri = editor.notebook.uri;
    return normalizedTargets.includes(uri.toString()) || normalizedTargets.includes(uri.fsPath);
  });
}

async function focusNotebookEditor(editor) {
  return vscode.window.showNotebookDocument(editor.notebook, {
    preserveFocus: false,
    preview: false,
    viewColumn: editor.viewColumn
  });
}

function snapshotCellState(cell) {
  return JSON.stringify({
    execution_summary: toExecutionSummary(cell),
    outputs: cell.outputs.map((output, index) => toOutputInfo(output, index))
  });
}

function snapshotNotebookState(notebook) {
  const cells = [];
  for (let index = 0; index < notebook.cellCount; index += 1) {
    cells.push(snapshotCellState(notebook.cellAt(index)));
  }
  return JSON.stringify(cells);
}

function waitForNotebookMutation(notebook, hasChanged, timeoutMs) {
  return new Promise((resolve, reject) => {
    const quietPeriodMs = 750;
    let quietTimer;
    let timeoutTimer;

    const subscription = vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (event.notebook.uri.toString() !== notebook.uri.toString()) {
        return;
      }

      if (!hasChanged()) {
        return;
      }

      if (quietTimer) {
        clearTimeout(quietTimer);
      }

      quietTimer = setTimeout(() => {
        cleanup();
        resolve();
      }, quietPeriodMs);
    });

    const cleanup = () => {
      subscription.dispose();
      if (quietTimer) {
        clearTimeout(quietTimer);
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
    };

    timeoutTimer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for notebook execution after ${timeoutMs}ms.`));
    }, timeoutMs);

    if (hasChanged()) {
      quietTimer = setTimeout(() => {
        cleanup();
        resolve();
      }, quietPeriodMs);
    }
  });
}

async function runNotebookCell(editor, cellIndex, waitForChange, timeoutMs) {
  const notebook = editor.notebook;
  const cell = getCellOrThrow(notebook, cellIndex);
  const before = snapshotCellState(cell);

  await focusNotebookEditor(editor);
  await vscode.commands.executeCommand("notebook.cell.execute", {
    document: notebook.uri,
    ranges: [{ start: cellIndex, end: cellIndex + 1 }]
  });

  if (waitForChange) {
    await waitForNotebookMutation(
      notebook,
      () => snapshotCellState(notebook.cellAt(cellIndex)) !== before,
      timeoutMs
    );
  }

  return {
    notebook_uri: notebook.uri.toString(),
    file_path: notebook.uri.fsPath,
    waited: waitForChange,
    cell: toCellOutputsDetail(notebook.cellAt(cellIndex), cellIndex)
  };
}

async function runNotebookAll(editor, waitForChange, timeoutMs) {
  const notebook = editor.notebook;
  const before = snapshotNotebookState(notebook);

  await focusNotebookEditor(editor);
  await vscode.commands.executeCommand("notebook.execute", notebook.uri);

  if (waitForChange) {
    await waitForNotebookMutation(
      notebook,
      () => snapshotNotebookState(notebook) !== before,
      timeoutMs
    );
  }

  return {
    notebook_uri: notebook.uri.toString(),
    file_path: notebook.uri.fsPath,
    waited: waitForChange,
    notebook: toNotebookDetail(editor)
  };
}

async function replaceNotebookCellSource(editor, cellIndex, source) {
  const currentCell = getCellOrThrow(editor.notebook, cellIndex);
  return applyNotebookEdit(editor.notebook, [
    vscode.NotebookEdit.replaceCells(
      new vscode.NotebookRange(cellIndex, cellIndex + 1),
      [createCellDataFromExistingCell(currentCell, source)]
    )
  ]);
}

function createCellDataFromExistingCell(cell, source) {
  const replacementCell = new vscode.NotebookCellData(
    cell.kind,
    source,
    cell.document.languageId
  );

  replacementCell.metadata = cell.metadata;
  if (cell.kind === vscode.NotebookCellKind.Code) {
    replacementCell.outputs = [];
  }

  return replacementCell;
}

function createCellData(kind, language, source) {
  const notebookKind = kind === "markdown" ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;
  const effectiveLanguage = notebookKind === vscode.NotebookCellKind.Markup
    ? "markdown"
    : (language || "python");
  const cell = new vscode.NotebookCellData(notebookKind, source, effectiveLanguage);
  if (notebookKind === vscode.NotebookCellKind.Code) {
    cell.outputs = [];
  }
  return cell;
}

async function applyNotebookEdit(notebook, edits) {
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, edits);

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error("VS Code rejected the notebook edit.");
  }

  const saved = await notebook.save();
  return { saved };
}

function getCellOrThrow(notebook, cellIndex) {
  if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= notebook.cellCount) {
    throw new Error(`Cell index ${cellIndex} is out of range for notebook with ${notebook.cellCount} cells.`);
  }
  return notebook.cellAt(cellIndex);
}

async function addNotebookCell(editor, cellIndex, kind, language, source) {
  const notebook = editor.notebook;
  if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex > notebook.cellCount) {
    throw new Error(`Insert index ${cellIndex} is out of range for notebook with ${notebook.cellCount} cells.`);
  }

  return applyNotebookEdit(notebook, [
    vscode.NotebookEdit.insertCells(cellIndex, [createCellData(kind, language, source)])
  ]);
}

async function deleteNotebookCell(editor, cellIndex) {
  const notebook = editor.notebook;
  getCellOrThrow(notebook, cellIndex);

  return applyNotebookEdit(notebook, [
    vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(cellIndex, cellIndex + 1))
  ]);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload, null, 2));
}

function isAuthorized(req, token) {
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${token}`;
}

async function handleRequest(req, res, token, outputChannel) {
  if (!isAuthorized(req, token)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const body = await readJsonBody(req);
  outputChannel.appendLine(`Notebook Bridge request ${req.url}`);

  if (req.url === "/list-open") {
    const notebooks = getVisibleNotebookEditors().map(toNotebookSummary);
    sendJson(res, 200, { notebooks });
    return;
  }

  if (req.url === "/get") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      sendJson(res, 404, {
        error: "Notebook is not open in a visible VS Code notebook editor."
      });
      return;
    }

    sendJson(res, 200, toNotebookDetail(notebook));
    return;
  }

  if (req.url === "/inspect" || req.url === "/list-cells") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      sendJson(res, 404, {
        error: "Notebook is not open in a visible VS Code notebook editor."
      });
      return;
    }

    sendJson(res, 200, toNotebookInspection(notebook));
    return;
  }

  if (req.url === "/get-cell") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      sendJson(res, 404, {
        error: "Notebook is not open in a visible VS Code notebook editor."
      });
      return;
    }

    const cell = getCellOrThrow(notebook.notebook, body.cell_index);
    sendJson(res, 200, {
      notebook_uri: notebook.notebook.uri.toString(),
      file_path: notebook.notebook.uri.fsPath,
      cell: toCellDetail(cell, body.cell_index)
    });
    return;
  }

  if (req.url === "/get-outputs") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      sendJson(res, 404, {
        error: "Notebook is not open in a visible VS Code notebook editor."
      });
      return;
    }

    const cell = getCellOrThrow(notebook.notebook, body.cell_index);
    sendJson(res, 200, {
      notebook_uri: notebook.notebook.uri.toString(),
      file_path: notebook.notebook.uri.fsPath,
      cell: toCellOutputsDetail(cell, body.cell_index)
    });
    return;
  }

  if (req.url === "/replace-cell") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      sendJson(res, 404, {
        error: "Notebook is not open in a visible VS Code notebook editor."
      });
      return;
    }

    if (typeof body.source !== "string") {
      sendJson(res, 400, {
        error: "Missing replacement source text."
      });
      return;
    }

    await replaceNotebookCellSource(notebook, body.cell_index, body.source);
    sendJson(res, 200, toNotebookDetail(notebook));
    return;
  }

  if (req.url === "/run-cell") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      sendJson(res, 404, {
        error: "Notebook is not open in a visible VS Code notebook editor."
      });
      return;
    }

    const result = await runNotebookCell(
      notebook,
      body.cell_index,
      Boolean(body.wait),
      Number.isInteger(body.timeout_ms) ? body.timeout_ms : 30000
    );
    sendJson(res, 200, result);
    return;
  }

  if (req.url === "/run-all") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      sendJson(res, 404, {
        error: "Notebook is not open in a visible VS Code notebook editor."
      });
      return;
    }

    const result = await runNotebookAll(
      notebook,
      Boolean(body.wait),
      Number.isInteger(body.timeout_ms) ? body.timeout_ms : 30000
    );
    sendJson(res, 200, result);
    return;
  }

  if (req.url === "/add-cell") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      sendJson(res, 404, {
        error: "Notebook is not open in a visible VS Code notebook editor."
      });
      return;
    }

    if (typeof body.source !== "string") {
      sendJson(res, 400, { error: "Missing new cell source text." });
      return;
    }

    if (body.kind !== "code" && body.kind !== "markdown") {
      sendJson(res, 400, { error: "Cell kind must be `code` or `markdown`." });
      return;
    }

    await addNotebookCell(notebook, body.cell_index, body.kind, body.language, body.source);
    sendJson(res, 200, toNotebookDetail(notebook));
    return;
  }

  if (req.url === "/delete-cell") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      sendJson(res, 404, {
        error: "Notebook is not open in a visible VS Code notebook editor."
      });
      return;
    }

    await deleteNotebookCell(notebook, body.cell_index);
    sendJson(res, 200, toNotebookDetail(notebook));
    return;
  }

  sendJson(res, 404, { error: "Unknown endpoint" });
}

async function activate(context) {
  const outputChannel = vscode.window.createOutputChannel("Notebook Bridge");
  const token = crypto.randomBytes(24).toString("hex");

  const server = http.createServer((req, res) => {
    handleRequest(req, res, token, outputChannel).catch((error) => {
      outputChannel.appendLine(`Notebook Bridge error: ${error.stack || error.message}`);
      sendJson(res, 500, { error: error.message });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Notebook Bridge failed to bind a localhost port.");
  }

  const state = {
    extension_path: __dirname,
    port: address.port,
    token,
    state_file: stateFilePath(),
    state_files: stateFilePaths(),
    updated_at: new Date().toISOString()
  };

  const writtenStateFiles = writeStateFiles(state, outputChannel);
  outputChannel.appendLine(`Notebook Bridge listening on http://127.0.0.1:${address.port}`);
  outputChannel.appendLine(`State files: ${writtenStateFiles.join(", ")}`);

  const showServerInfo = vscode.commands.registerCommand("notebookBridge.showServerInfo", async () => {
    await vscode.window.showInformationMessage(
      `Notebook Bridge listening on 127.0.0.1:${address.port}. State file: ${writtenStateFiles[0]}`
    );
    outputChannel.show(true);
  });

  context.subscriptions.push(showServerInfo);
  context.subscriptions.push({
    dispose: () => {
      for (const filePath of writtenStateFiles) {
        try {
          fs.unlinkSync(filePath);
        } catch (error) {
          if (error.code !== "ENOENT") {
            outputChannel.appendLine(`Failed to remove state file ${filePath}: ${error.message}`);
          }
        }
      }
      server.close();
      outputChannel.dispose();
    }
  });
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
