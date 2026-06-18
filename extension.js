const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vscode = require("vscode");
const { summarizeCell } = require("./lib/notebook-inspection");
const { createLogger } = require("./lib/logger");

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

function decodeOutputItemData(item) {
  const mime = item.mime;
  const bytes = Buffer.from(item.data);

  if (mime.startsWith("text/") || mime === "application/x.notebook.stdout" || mime === "application/x.notebook.stderr" || mime === "application/vnd.code.notebook.stdout" || mime === "application/vnd.code.notebook.stderr") {
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
    notebook_cell_id: cell.metadata?.id ?? null,
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
    notebook_cell_id: cell.metadata?.id ?? null,
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
    notebook_cell_id: cell.metadata?.id ?? null,
    index,
    kind: cell.kind === vscode.NotebookCellKind.Markup ? "markdown" : "code",
    language: cell.document.languageId,
    execution_summary: toExecutionSummary(cell),
    outputs: cell.outputs.map(toOutputInfo)
  };
}

function findNotebookErrors(notebook) {
  const errors = [];

  for (let index = 0; index < notebook.cellCount; index += 1) {
    const cell = notebook.cellAt(index);
    if (cell.kind !== vscode.NotebookCellKind.Code) {
      continue;
    }

    const summary = cell.executionSummary;
    if (!summary || summary.success !== false) {
      continue;
    }

    let errorDetail = null;
    outer: for (const output of cell.outputs) {
      for (const item of output.items) {
        if (item.mime === "application/vnd.code.notebook.error") {
          try {
            errorDetail = JSON.parse(Buffer.from(item.data).toString("utf8"));
          } catch {
            // leave errorDetail null
          }
          break outer;
        }
      }
    }

    errors.push({
      id: `c${index}`,
      notebook_cell_id: cell.metadata?.id ?? null,
      cell_index: index,
      source: cell.document.getText(),
      error: errorDetail
    });
  }

  return errors;
}

function isNotebookVisible(notebook) {
  return vscode.window.visibleNotebookEditors.some(
    (editor) => editor.notebook.uri.toString() === notebook.uri.toString()
  );
}

function toNotebookSummary(notebook) {
  return {
    notebook_uri: notebook.uri.toString(),
    file_path: notebook.uri.fsPath,
    notebook_type: notebook.notebookType,
    cell_count: notebook.cellCount,
    is_active: vscode.window.activeNotebookEditor?.notebook.uri.toString() === notebook.uri.toString(),
    is_visible: isNotebookVisible(notebook)
  };
}

function toNotebookDetail(notebook) {
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

function toNotebookInspection(notebook) {
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
  const summary = summarizeCell(
    cell,
    index,
    cell.kind === vscode.NotebookCellKind.Markup ? "markdown" : "code"
  );
  return { ...summary, notebook_cell_id: cell.metadata?.id ?? null };
}

function findOpenNotebook(targets) {
  const normalizedTargets = []
    .concat(targets || [])
    .filter(Boolean)
    .map((target) => String(target));

  return vscode.workspace.notebookDocuments.find((notebook) => {
    const uri = notebook.uri;
    return normalizedTargets.includes(uri.toString()) || normalizedTargets.includes(uri.fsPath);
  });
}

// Finds the existing visible editor for a notebook, or opens it in a side
// panel with preserveFocus so the user's current editor keeps focus.
async function getOrEnsureNotebookEditor(notebook) {
  const existing = vscode.window.visibleNotebookEditors.find(
    (editor) => editor.notebook.uri.toString() === notebook.uri.toString()
  );
  if (existing) {
    return existing;
  }
  return vscode.window.showNotebookDocument(notebook, {
    preserveFocus: true,
    preview: false,
    viewColumn: vscode.ViewColumn.Beside
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

function waitForNotebookMutation(notebook, hasChanged, timeoutMs, signal) {
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

    const onAbort = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      subscription.dispose();
      if (quietTimer) {
        clearTimeout(quietTimer);
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal) {
      if (signal.aborted) {
        cleanup();
        resolve();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

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

async function runNotebookCell(notebook, cellIndex, waitForChange, timeoutMs, signal) {
  const cell = getCellOrThrow(notebook, cellIndex);

  if (cell.kind === vscode.NotebookCellKind.Markup) {
    return {
      notebook_uri: notebook.uri.toString(),
      file_path: notebook.uri.fsPath,
      waited: false,
      skipped: true,
      skip_reason: "markdown",
      cell: toCellOutputsInfo(cell, cellIndex)
    };
  }

  const before = snapshotCellState(cell);

  // await getOrEnsureNotebookEditor(notebook);
  await vscode.commands.executeCommand("notebook.cell.execute", {
    document: notebook.uri,
    ranges: [{ start: cellIndex, end: cellIndex + 1 }]
  });

  if (waitForChange) {
    await waitForNotebookMutation(
      notebook,
      () => snapshotCellState(notebook.cellAt(cellIndex)) !== before,
      timeoutMs,
      signal
    );
  }

  return {
    notebook_uri: notebook.uri.toString(),
    file_path: notebook.uri.fsPath,
    waited: waitForChange,
    cell: toCellOutputsInfo(notebook.cellAt(cellIndex), cellIndex)
  };
}

async function runNotebookAll(notebook, waitForChange, timeoutMs, signal) {
  const before = snapshotNotebookState(notebook);

  // await getOrEnsureNotebookEditor(notebook);
  await vscode.commands.executeCommand("notebook.execute", notebook.uri);

  if (waitForChange) {
    await waitForNotebookMutation(
      notebook,
      () => snapshotNotebookState(notebook) !== before,
      timeoutMs,
      signal
    );
  }

  return {
    notebook_uri: notebook.uri.toString(),
    file_path: notebook.uri.fsPath,
    waited: waitForChange,
    notebook: toNotebookDetail(notebook)
  };
}

async function replaceNotebookCellSource(notebook, cellIndex, source, save = false) {
  const currentCell = getCellOrThrow(notebook, cellIndex);
  return applyNotebookEdit(notebook, [
    vscode.NotebookEdit.replaceCells(
      new vscode.NotebookRange(cellIndex, cellIndex + 1),
      [createCellDataFromExistingCell(currentCell, source)]
    )
  ], save);
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

async function applyNotebookEdit(notebook, edits, save = false) {
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, edits);

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error("VS Code rejected the notebook edit.");
  }

  if (save) {
    await notebook.save();
  }
}

function getCellOrThrow(notebook, cellIndex) {
  if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= notebook.cellCount) {
    throw new Error(`Cell index ${cellIndex} is out of range for notebook with ${notebook.cellCount} cells.`);
  }
  return notebook.cellAt(cellIndex);
}

function resolveCellIndex(notebook, body) {
  if (typeof body.cell_id === "string") {
    for (let i = 0; i < notebook.cellCount; i += 1) {
      if (notebook.cellAt(i).metadata?.id === body.cell_id) {
        return i;
      }
    }
    throw new Error(`No cell with id "${body.cell_id}" found in the notebook.`);
  }
  const index = body.cell_index;
  if (!Number.isInteger(index) || index < 0 || index >= notebook.cellCount) {
    throw new Error(`Cell index ${index} is out of range for notebook with ${notebook.cellCount} cells.`);
  }
  return index;
}

async function addNotebookCell(notebook, cellIndex, kind, language, source, save = false) {
  if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex > notebook.cellCount) {
    throw new Error(`Insert index ${cellIndex} is out of range for notebook with ${notebook.cellCount} cells.`);
  }

  return applyNotebookEdit(notebook, [
    vscode.NotebookEdit.insertCells(cellIndex, [createCellData(kind, language, source)])
  ], save);
}

async function deleteNotebookCell(notebook, cellIndex, save = false) {
  getCellOrThrow(notebook, cellIndex);

  return applyNotebookEdit(notebook, [
    vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(cellIndex, cellIndex + 1))
  ], save);
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

async function handleRequest(req, res, token, outputChannel, logger) {
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
  const startMs = Date.now();
  outputChannel.appendLine(`Notebook Bridge request ${req.url}`);
  logger.request(req.url, body);

  const originalSendJson = sendJson;
  const loggedSendJson = (r, statusCode, payload) => {
    const ms = Date.now() - startMs;
    const errorMessage = statusCode >= 400 ? (payload.error || null) : null;
    logger.response(req.url, statusCode, ms, errorMessage);
    originalSendJson(r, statusCode, payload);
  };

  if (req.url === "/list-open") {
    const notebooks = vscode.workspace.notebookDocuments.map(toNotebookSummary);
    loggedSendJson(res, 200, { notebooks });
    return;
  }

  if (req.url === "/get") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      loggedSendJson(res, 404, { error: "Notebook is not open in VS Code." });
      return;
    }

    loggedSendJson(res, 200, toNotebookDetail(notebook));
    return;
  }

  if (req.url === "/inspect" || req.url === "/list-cells") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      loggedSendJson(res, 404, { error: "Notebook is not open in VS Code." });
      return;
    }

    loggedSendJson(res, 200, toNotebookInspection(notebook));
    return;
  }

  if (req.url === "/get-cell") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      loggedSendJson(res, 404, { error: "Notebook is not open in VS Code." });
      return;
    }

    const cellIndex = resolveCellIndex(notebook, body);
    loggedSendJson(res, 200, {
      notebook_uri: notebook.uri.toString(),
      file_path: notebook.uri.fsPath,
      cell: toCellSourceInfo(notebook.cellAt(cellIndex), cellIndex)
    });
    return;
  }

  if (req.url === "/get-outputs") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      loggedSendJson(res, 404, { error: "Notebook is not open in VS Code." });
      return;
    }

    const cellIndex = resolveCellIndex(notebook, body);
    loggedSendJson(res, 200, {
      notebook_uri: notebook.uri.toString(),
      file_path: notebook.uri.fsPath,
      cell: toCellOutputsInfo(notebook.cellAt(cellIndex), cellIndex)
    });
    return;
  }

  if (req.url === "/replace-cell") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      loggedSendJson(res, 404, { error: "Notebook is not open in VS Code." });
      return;
    }

    if (typeof body.source !== "string") {
      loggedSendJson(res, 400, { error: "Missing replacement source text." });
      return;
    }

    const cellIndex = resolveCellIndex(notebook, body);
    await replaceNotebookCellSource(notebook, cellIndex, body.source, Boolean(body.save));
    loggedSendJson(res, 200, {
      notebook_uri: notebook.uri.toString(),
      file_path: notebook.uri.fsPath,
      cell: toCellSourceInfo(notebook.cellAt(cellIndex), cellIndex)
    });
    return;
  }

  if (req.url === "/replace-and-run") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      loggedSendJson(res, 404, { error: "Notebook is not open in VS Code." });
      return;
    }

    if (typeof body.source !== "string") {
      loggedSendJson(res, 400, { error: "Missing replacement source text." });
      return;
    }

    const cellIndex = resolveCellIndex(notebook, body);
    await replaceNotebookCellSource(notebook, cellIndex, body.source, Boolean(body.save));
    const ac = new AbortController();
    req.on("close", () => ac.abort());
    const result = await runNotebookCell(
      notebook,
      cellIndex,
      true,
      Number.isInteger(body.timeout_ms) ? body.timeout_ms : 30000,
      ac.signal
    );
    loggedSendJson(res, 200, result);
    return;
  }

  if (req.url === "/run-cell") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      loggedSendJson(res, 404, { error: "Notebook is not open in VS Code." });
      return;
    }

    const cellIndex = resolveCellIndex(notebook, body);
    const ac = new AbortController();
    req.on("close", () => ac.abort());
    const result = await runNotebookCell(
      notebook,
      cellIndex,
      Boolean(body.wait),
      Number.isInteger(body.timeout_ms) ? body.timeout_ms : 30000,
      ac.signal
    );
    loggedSendJson(res, 200, result);
    return;
  }

  if (req.url === "/run-all") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      loggedSendJson(res, 404, { error: "Notebook is not open in VS Code." });
      return;
    }

    const ac = new AbortController();
    req.on("close", () => ac.abort());
    const result = await runNotebookAll(
      notebook,
      Boolean(body.wait),
      Number.isInteger(body.timeout_ms) ? body.timeout_ms : 30000,
      ac.signal
    );
    loggedSendJson(res, 200, result);
    return;
  }

  if (req.url === "/add-cell") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      loggedSendJson(res, 404, { error: "Notebook is not open in VS Code." });
      return;
    }

    if (typeof body.source !== "string") {
      loggedSendJson(res, 400, { error: "Missing new cell source text." });
      return;
    }

    if (body.kind !== "code" && body.kind !== "markdown") {
      loggedSendJson(res, 400, { error: "Cell kind must be `code` or `markdown`." });
      return;
    }

    await addNotebookCell(notebook, body.cell_index, body.kind, body.language, body.source, Boolean(body.save));
    const newCell = notebook.cellAt(body.cell_index);
    loggedSendJson(res, 200, {
      notebook_uri: notebook.uri.toString(),
      file_path: notebook.uri.fsPath,
      cell_count: notebook.cellCount,
      cell: toCellSourceInfo(newCell, body.cell_index)
    });
    return;
  }

  if (req.url === "/delete-cell") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      loggedSendJson(res, 404, { error: "Notebook is not open in VS Code." });
      return;
    }

    const cellIndex = resolveCellIndex(notebook, body);
    await deleteNotebookCell(notebook, cellIndex, Boolean(body.save));
    loggedSendJson(res, 200, {
      notebook_uri: notebook.uri.toString(),
      file_path: notebook.uri.fsPath,
      cell_count: notebook.cellCount,
      deleted_cell_index: cellIndex
    });
    return;
  }

  if (req.url === "/find-error") {
    const notebook = findOpenNotebook([body.notebook_uri, body.file_path]);
    if (!notebook) {
      loggedSendJson(res, 404, { error: "Notebook is not open in VS Code." });
      return;
    }

    const errors = findNotebookErrors(notebook);
    loggedSendJson(res, 200, {
      notebook_uri: notebook.uri.toString(),
      file_path: notebook.uri.fsPath,
      error_count: errors.length,
      first_error: errors[0] ?? null,
      errors
    });
    return;
  }

  if (req.url === "/new-notebook") {
    let notebook;

    if (body.file_path) {
      const uri = vscode.Uri.file(path.resolve(body.file_path));
      try {
        await vscode.workspace.fs.stat(uri);
        loggedSendJson(res, 400, { error: `File already exists: ${body.file_path}` });
        return;
      } catch {
        // Expected: file doesn't exist yet
      }
      const content = JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }, null, 1);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
      notebook = await vscode.workspace.openNotebookDocument(uri);
    } else {
      notebook = await vscode.workspace.openNotebookDocument(
        "jupyter-notebook",
        new vscode.NotebookData([])
      );
    }

    await vscode.window.showNotebookDocument(notebook, { preserveFocus: true, preview: false });
    loggedSendJson(res, 200, toNotebookSummary(notebook));
    return;
  }

  loggedSendJson(res, 404, { error: "Unknown endpoint" });
}

async function activate(context) {
  const outputChannel = vscode.window.createOutputChannel("Notebook Bridge");
  const logFile = path.join(os.homedir(), ".notebook-bridge", "bridge.log");
  const logger = createLogger(logFile);
  const token = crypto.randomBytes(24).toString("hex");

  const server = http.createServer((req, res) => {
    handleRequest(req, res, token, outputChannel, logger).catch((error) => {
      outputChannel.appendLine(`Notebook Bridge error: ${error.stack || error.message}`);
      logger.error(error.stack || error.message);
      sendJson(res, 500, { error: error.message });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  server.unref();

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Notebook Bridge failed to bind a localhost port.");
  }

  const state = {
    extension_path: __dirname,
    port: address.port,
    token,
    log_file: logFile,
    state_file: stateFilePath(),
    state_files: stateFilePaths(),
    updated_at: new Date().toISOString()
  };

  const writtenStateFiles = writeStateFiles(state, outputChannel);
  outputChannel.appendLine(`Notebook Bridge listening on http://127.0.0.1:${address.port}`);
  outputChannel.appendLine(`State files: ${writtenStateFiles.join(", ")}`);
  outputChannel.appendLine(`Log file: ${logFile}`);
  logger.info(`Server started on port ${address.port} state=${writtenStateFiles[0]}`);

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
