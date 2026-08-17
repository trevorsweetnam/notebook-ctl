#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");
const registry = require("../lib/instance-registry");

const CODE_CLI_CANDIDATES = [
  process.env.NBCTL_CODE_CLI,
  "code",
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
].filter(Boolean);

const NOTEBOOK_TARGETED_COMMANDS = new Set([
  "get",
  "inspect",
  "list-cells",
  "get-cell",
  "get-outputs",
  "replace-cell",
  "patch-cell",
  "replace-and-run",
  "run-cell",
  "run-all",
  "add-cell",
  "delete-cell",
  "find-error"
]);

function usage() {
  return `Usage:
  nbctl list-open
  nbctl inspect <notebook-uri-or-path>         compact summary: kind, preview, lengths, mime types
  nbctl list-cells <notebook-uri-or-path>      (alias for inspect)
  nbctl get <notebook-uri-or-path>             full content: all source and outputs for every cell
  nbctl get-cell <notebook-uri-or-path> <cell-index-or-id>
  nbctl get-outputs <notebook-uri-or-path> <cell-index-or-id> [--print]
  nbctl run-cell <notebook-uri-or-path> <cell-index-or-id> [--wait] [--timeout-ms <ms>] [--print]
                                               (without --wait, outputs in the response are from the previous run)
  nbctl run-all <notebook-uri-or-path> [--wait] [--timeout-ms <ms>]
  nbctl replace-cell <notebook-uri-or-path> <cell-index-or-id> (--text <text> | --file <path>) [--save]
  nbctl patch-cell <notebook-uri-or-path> <cell-index-or-id> --old-file <path> --new-file <path> [--save]
  nbctl replace-and-run <notebook-uri-or-path> <cell-index-or-id> (--text <text> | --file <path>) [--timeout-ms <ms>] [--save] [--print]
                                               (always waits for completion)
  nbctl add-cell <notebook-uri-or-path> <insert-index> --kind <code|markdown> [--language <id>] (--text <text> | --file <path>) [--save]
  nbctl delete-cell <notebook-uri-or-path> <cell-index-or-id> [--save]
  nbctl find-error <notebook-uri-or-path> [--all]
  nbctl new-notebook [--path <file-path>]
  nbctl bootstrap
  nbctl doctor
  nbctl status
  nbctl help

Flags:
  --print    Print cell outputs as plain text (get-outputs, run-cell, replace-and-run)
  --text     Provide cell source content inline (replace-cell, add-cell, replace-and-run)
  --file     Provide cell source content from a file path (same commands as --text)
  --save     Persist the notebook to disk after the operation
  --wait     Block until cell execution completes and outputs are ready

Environment:
  NBCTL_STATE_FILE    Override the bridge state file path.
  NBCTL_INSTANCE_PID  Force routing to a specific VS Code window (pid from \`nbctl status\`).
  NBCTL_CODE_CLI      Override the VS Code CLI executable used by bootstrap.

Multiple windows:
  When more than one VS Code window is open, notebook-targeted commands (get, inspect,
  run-cell, etc.) automatically route to whichever window has that notebook open. If the
  notebook is open in more than one window, the most recently focused window is used.
  Set NBCTL_INSTANCE_PID to force a specific window instead.
`;
}

function parseNotebookTargetArg(command, args) {
  const target = args[0];
  if (!target) {
    throw createCliError("invalid_argument", `Missing notebook URI or path for \`${command}\`.`);
  }
  return target;
}

function writeJson(payload, exitCode = 0) {
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(json);
  process.exitCode = exitCode;
}

function fail(code, message, details) {
  writeJson({
    ok: false,
    error: {
      code,
      message,
      details: details || null
    }
  }, 1);
}

function success(command, data) {
  writeJson({
    ok: true,
    command,
    data
  });
}

function bundledVsixPath() {
  return path.resolve(__dirname, "..", "notebook-bridge-0.0.1.vsix");
}

function findCodeCli() {
  for (const candidate of CODE_CLI_CANDIDATES) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }
  return null;
}

function runCodeCli(codeCli, args) {
  const result = spawnSync(codeCli, args, { encoding: "utf8" });
  if (result.error) {
    throw createCliError("vscode_cli_failed", `Failed to run VS Code CLI: ${result.error.message}`, {
      code_cli: codeCli,
      args
    });
  }

  if (result.status !== 0) {
    throw createCliError("vscode_cli_failed", "VS Code CLI command failed.", {
      code_cli: codeCli,
      args,
      exit_code: result.status,
      stdout: result.stdout || "",
      stderr: result.stderr || ""
    });
  }

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

function bootstrapBridge() {
  const codeCli = findCodeCli();
  if (!codeCli) {
    throw createCliError(
      "vscode_cli_not_found",
      "VS Code CLI was not found. Install the `code` shell command or set NBCTL_CODE_CLI.",
      { tried: CODE_CLI_CANDIDATES }
    );
  }

  const vsix = bundledVsixPath();
  if (!fs.existsSync(vsix)) {
    throw createCliError(
      "vsix_not_found",
      "Bundled Notebook Bridge VSIX was not found. Run `npm run package:vsix` first.",
      { vsix }
    );
  }

  const install = runCodeCli(codeCli, ["--install-extension", vsix, "--force"]);
  const open = runCodeCli(codeCli, ["--reuse-window", path.resolve(__dirname, "..")]);
  return {
    code_cli: codeCli,
    vsix,
    install,
    open,
    next_step: "Reload the VS Code window if it was already open, then run `nbctl status` or `nbctl list-open`."
  };
}

function loadLiveInstances() {
  const statePath = process.env.NBCTL_STATE_FILE || undefined;
  const raw = registry.loadInstances({ statePath });
  return registry.pruneDeadInstances(raw);
}

function requireLiveInstances() {
  const instances = loadLiveInstances();
  if (instances.length === 0) {
    throw createCliError(
      "bridge_not_available",
      "No running Notebook Bridge instances were found. Run `nbctl bootstrap`, then open/reload VS Code so the extension can start.",
      {
        state_candidates: registry.statePaths(),
        env_var: "NBCTL_STATE_FILE",
        bootstrap_command: "nbctl bootstrap",
        diagnostic_command: "nbctl doctor"
      }
    );
  }
  return instances;
}

function instanceForcedByEnv(instances) {
  const forcedPidRaw = process.env.NBCTL_INSTANCE_PID;
  if (!forcedPidRaw) {
    return null;
  }

  const forcedPid = Number.parseInt(forcedPidRaw, 10);
  const found = instances.find((instance) => instance.pid === forcedPid);
  if (!found) {
    throw createCliError(
      "instance_not_found",
      `NBCTL_INSTANCE_PID=${forcedPidRaw} does not match any running Notebook Bridge instance.`,
      {
        requested_pid: forcedPid,
        live_pids: instances.map((instance) => instance.pid)
      }
    );
  }
  return found;
}

async function probeInstance(instance) {
  try {
    const data = await requestJson(instance, "/list-open", {}, { timeoutMs: 4000 });
    return { instance, reachable: true, notebooks: data.notebooks || [] };
  } catch (error) {
    return { instance, reachable: false, error };
  }
}

function describeInstance(instance) {
  return {
    pid: instance.pid,
    port: instance.port,
    workspace_folders: instance.workspace_folders || [],
    focused_at: instance.focused_at || null,
    updated_at: instance.updated_at || null
  };
}

function sortByMostRecentlyFocused(entries, getInstance) {
  return [...entries].sort((a, b) => {
    const aFocusedAt = getInstance(a).focused_at || "";
    const bFocusedAt = getInstance(b).focused_at || "";
    return bFocusedAt.localeCompare(aFocusedAt);
  });
}

async function resolveInstanceForTarget(target, instances) {
  const forced = instanceForcedByEnv(instances);
  if (forced) {
    return forced;
  }

  const normalizedTarget = normalizeNotebookTarget(target);
  const probes = await Promise.all(instances.map(probeInstance));

  const matches = probes.filter(({ reachable, notebooks }) =>
    reachable &&
    notebooks.some((notebook) =>
      (normalizedTarget.notebook_uri && notebook.notebook_uri === normalizedTarget.notebook_uri) ||
      (normalizedTarget.file_path && notebook.file_path === normalizedTarget.file_path)
    )
  );

  if (matches.length === 0) {
    throw createCliError(
      "notebook_not_open",
      `Notebook is not open in any running VS Code window: ${target}`,
      {
        target,
        checked_instances: probes.map(({ instance, reachable, error }) => ({
          ...describeInstance(instance),
          reachable,
          error: reachable ? null : error.message
        }))
      }
    );
  }

  const sorted = sortByMostRecentlyFocused(matches, (match) => match.instance);
  return sorted[0].instance;
}

function resolveInstanceForNewNotebook(filePath, instances) {
  const forced = instanceForcedByEnv(instances);
  if (forced) {
    return forced;
  }

  if (filePath) {
    const absolutePath = path.resolve(filePath);
    const owning = instances.filter((instance) =>
      (instance.workspace_folders || []).some((folder) => {
        const relative = path.relative(folder, absolutePath);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      })
    );
    if (owning.length > 0) {
      return sortByMostRecentlyFocused(owning, (instance) => instance)[0];
    }
  }

  return sortByMostRecentlyFocused(instances, (instance) => instance)[0];
}

async function doctor() {
  const instances = loadLiveInstances();
  const health = await Promise.all(instances.map(async (instance) => {
    try {
      const result = await requestJson(instance, "/health", undefined, { timeoutMs: 4000 });
      return { ...describeInstance(instance), reachable: true, health: result };
    } catch (error) {
      return {
        ...describeInstance(instance),
        reachable: false,
        error: { code: error.code || "unexpected_error", message: error.message }
      };
    }
  }));

  return {
    state_candidates: registry.statePaths(),
    instance_count: instances.length,
    instances: instances.map(describeInstance),
    code_cli: findCodeCli(),
    code_cli_candidates: CODE_CLI_CANDIDATES,
    bundled_vsix: bundledVsixPath(),
    bundled_vsix_exists: fs.existsSync(bundledVsixPath()),
    health
  };
}

function normalizeNotebookTarget(target) {
  if (!target) {
    return {};
  }

  if (target.startsWith("file://")) {
    return { notebook_uri: target };
  }

  const absolutePath = path.resolve(target);
  return {
    notebook_uri: pathToFileURL(absolutePath).toString(),
    file_path: absolutePath
  };
}

function createCliError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details || null;
  return error;
}

function requestJson(instance, endpoint, payload, { timeoutMs } = {}) {
  const requestBody = endpoint === "/health" ? undefined : JSON.stringify(payload || {});

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: instance.port,
      path: endpoint,
      method: endpoint === "/health" ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${instance.token}`,
        "Content-Type": "application/json",
        "Content-Length": requestBody ? Buffer.byteLength(requestBody) : 0
      }
    }, (res) => {
      let body = "";

      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        let data = {};
        if (body) {
          try {
            data = JSON.parse(body);
          } catch (error) {
            reject(createCliError(
              "invalid_bridge_response",
              "Notebook Bridge returned invalid JSON.",
              { endpoint, reason: error.message, body, pid: instance.pid }
            ));
            return;
          }
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(createCliError(
            bridgeErrorCode(res.statusCode, data.error),
            bridgeErrorMessage(res.statusCode, data.error),
            {
              endpoint,
              status_code: res.statusCode,
              pid: instance.pid,
              port: instance.port
            }
          ));
          return;
        }

        resolve(data);
      });
    });

    if (Number.isInteger(timeoutMs)) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Timed out after ${timeoutMs}ms`));
      });
    }

    req.on("error", (error) => {
      if (error.code === "ECONNREFUSED") {
        reject(createCliError(
          "bridge_not_listening",
          `Notebook Bridge is not listening on 127.0.0.1:${instance.port} (pid ${instance.pid}). Open VS Code and run 'Notebook Bridge: Show Server Info' again.`,
          {
            port: instance.port,
            pid: instance.pid
          }
        ));
        return;
      }

      reject(createCliError(
        "bridge_request_failed",
        "Failed to contact Notebook Bridge.",
        {
          endpoint,
          reason: error.message,
          pid: instance.pid,
          port: instance.port
        }
      ));
    });

    if (requestBody) {
      req.write(requestBody);
    }

    req.end();
  });
}

function bridgeErrorCode(statusCode, message) {
  if (statusCode === 400) {
    return "invalid_request";
  }

  if (statusCode === 401) {
    return "bridge_auth_failed";
  }

  if (statusCode === 404) {
    if (message === "Notebook is not open in a visible VS Code notebook editor.") {
      return "notebook_not_open";
    }
    return "bridge_not_found";
  }

  if (statusCode >= 500) {
    return "bridge_internal_error";
  }

  return "bridge_request_failed";
}

function bridgeErrorMessage(statusCode, message) {
  if (message) {
    return message;
  }

  return `Notebook Bridge request failed with HTTP ${statusCode}.`;
}

function isUnknownEndpointError(error, endpoint) {
  return Boolean(
    error &&
    error.code === "bridge_not_found" &&
    error.details &&
    error.details.endpoint === endpoint &&
    error.message === "Unknown endpoint"
  );
}

async function readNotebookStructure(state, target, requestFn = requestJson) {
  const payload = normalizeNotebookTarget(target);
  try {
    return await requestFn(state, "/inspect", payload);
  } catch (error) {
    if (!isUnknownEndpointError(error, "/inspect")) {
      throw error;
    }
  }

  return requestFn(state, "/list-cells", payload);
}

function parseCellIndex(rawValue, label) {
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw createCliError(
      "invalid_argument",
      `Invalid ${label}: ${rawValue}`,
      { label, value: rawValue }
    );
  }
  return value;
}

// Returns {cell_index: N} for pure-integer args, {cell_id: "..."} for everything else.
// This lets callers use either positional index or the notebook's stable cell UUID.
function parseCellRef(rawValue, label) {
  if (/^\d+$/.test(rawValue)) {
    return { cell_index: parseCellIndex(rawValue, label) };
  }
  if (!rawValue) {
    throw createCliError("invalid_argument", `Missing ${label}.`);
  }
  return { cell_id: rawValue };
}

function readSourceFile(filePath) {
  if (filePath === "-") {
    try {
      return fs.readFileSync(0, "utf8");
    } catch (error) {
      throw createCliError("invalid_argument", "Failed to read from stdin.", { reason: error.message });
    }
  }

  const absolutePath = path.resolve(filePath);
  try {
    return fs.readFileSync(absolutePath, "utf8");
  } catch (error) {
    throw createCliError(
      "invalid_argument",
      `Failed to read source file at ${absolutePath}.`,
      { file_path: absolutePath, reason: error.message }
    );
  }
}

function parseSourceOption(args, startIndex) {
  let source;

  for (let index = startIndex; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--text") {
      if (source !== undefined) {
        throw createCliError("invalid_argument", "Provide only one of `--text` or `--file`.");
      }

      index += 1;
      if (index >= args.length) {
        throw createCliError("invalid_argument", "Missing value after `--text`.");
      }

      source = args[index];
      continue;
    }

    if (arg === "--file") {
      if (source !== undefined) {
        throw createCliError("invalid_argument", "Provide only one of `--text` or `--file`.");
      }

      index += 1;
      if (index >= args.length) {
        throw createCliError("invalid_argument", "Missing path after `--file`.");
      }

      source = readSourceFile(args[index]);
      continue;
    }

    throw createCliError("invalid_argument", `Unknown argument: ${arg}`, { argument: arg });
  }

  if (source === undefined) {
    throw createCliError("invalid_argument", "Missing replacement content. Use `--text` or `--file`.");
  }

  return source;
}

function parseReplaceCellArgs(args) {
  const target = args[0];
  const cellIndexRaw = args[1];

  if (!target) {
    throw createCliError("invalid_argument", "Missing notebook URI or path for `replace-cell`.");
  }

  if (cellIndexRaw === undefined) {
    throw createCliError("invalid_argument", "Missing cell index for `replace-cell`.");
  }

  const save = args.includes("--save");
  const filteredArgs = args.filter((a) => a !== "--save");
  return {
    target,
    cellRef: parseCellRef(cellIndexRaw, "cell index"),
    source: parseSourceOption(filteredArgs, 2),
    save
  };
}

function parsePatchCellArgs(args) {
  const target = args[0];
  const cellIndexRaw = args[1];

  if (!target) {
    throw createCliError("invalid_argument", "Missing notebook URI or path for `patch-cell`.");
  }

  if (cellIndexRaw === undefined) {
    throw createCliError("invalid_argument", "Missing cell index for `patch-cell`.");
  }

  const cellRef = parseCellRef(cellIndexRaw, "cell index");
  let oldFile;
  let newFile;
  let save = false;

  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--old-file") {
      index += 1;
      if (index >= args.length) {
        throw createCliError("invalid_argument", "Missing path after `--old-file`.");
      }
      oldFile = args[index];
      continue;
    }

    if (arg === "--new-file") {
      index += 1;
      if (index >= args.length) {
        throw createCliError("invalid_argument", "Missing path after `--new-file`.");
      }
      newFile = args[index];
      continue;
    }

    if (arg === "--save") {
      save = true;
      continue;
    }

    throw createCliError("invalid_argument", `Unknown argument for \`patch-cell\`: ${arg}`, { argument: arg });
  }

  if (oldFile === undefined) {
    throw createCliError("invalid_argument", "Missing `--old-file`.");
  }

  if (newFile === undefined) {
    throw createCliError("invalid_argument", "Missing `--new-file`.");
  }

  return {
    target,
    cellRef,
    oldSource: readSourceFile(oldFile),
    newSource: readSourceFile(newFile),
    save
  };
}

function applyPatch(cellSource, oldSource, newSource) {
  const firstIndex = cellSource.indexOf(oldSource);
  if (firstIndex === -1) {
    throw createCliError(
      "patch_not_found",
      "The old-file content was not found in the cell source.",
      { old_source: oldSource }
    );
  }

  const secondIndex = cellSource.indexOf(oldSource, firstIndex + 1);
  if (secondIndex !== -1) {
    throw createCliError(
      "patch_ambiguous",
      "The old-file content matches more than once in the cell source — it must be unique.",
      { old_source: oldSource }
    );
  }

  return cellSource.slice(0, firstIndex) + newSource + cellSource.slice(firstIndex + oldSource.length);
}

function parseAddCellArgs(args) {
  const target = args[0];
  const cellIndexRaw = args[1];

  if (!target) {
    throw createCliError("invalid_argument", "Missing notebook URI or path for `add-cell`.");
  }

  if (cellIndexRaw === undefined) {
    throw createCliError("invalid_argument", "Missing insert index for `add-cell`.");
  }

  const cellIndex = parseCellIndex(cellIndexRaw, "insert index");
  let kind;
  let language;
  let source;

  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--kind") {
      index += 1;
      if (index >= args.length) {
        throw createCliError("invalid_argument", "Missing value after `--kind`.");
      }
      kind = args[index];
      continue;
    }

    if (arg === "--language") {
      index += 1;
      if (index >= args.length) {
        throw createCliError("invalid_argument", "Missing value after `--language`.");
      }
      language = args[index];
      continue;
    }

    if (arg === "--text" || arg === "--file") {
      source = parseSourceOption(args, index);
      break;
    }

    if (arg === "--save") {
      continue;
    }

    throw createCliError("invalid_argument", `Unknown argument for \`add-cell\`: ${arg}`, { argument: arg });
  }

  if (kind !== "code" && kind !== "markdown") {
    throw createCliError("invalid_argument", "Cell kind must be `code` or `markdown`.");
  }

  if (source === undefined) {
    throw createCliError("invalid_argument", "Missing new cell content. Use `--text` or `--file`.");
  }

  const save = args.includes("--save");
  return { target, cellIndex, kind, language, source, save };
}

function parseNotebookAndIndexArgs(command, args) {
  const target = args[0];
  const cellIndexRaw = args[1];

  if (!target) {
    throw createCliError("invalid_argument", `Missing notebook URI or path for \`${command}\`.`);
  }

  if (cellIndexRaw === undefined) {
    throw createCliError("invalid_argument", `Missing cell index for \`${command}\`.`);
  }

  return {
    target,
    cellRef: parseCellRef(cellIndexRaw, "cell index"),
    save: args.includes("--save")
  };
}

function parseExecutionOptions(args, startIndex) {
  let wait = false;
  let timeoutMs = 30000;

  for (let index = startIndex; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--wait") {
      wait = true;
      continue;
    }

    if (arg === "--timeout-ms") {
      index += 1;
      if (index >= args.length) {
        throw createCliError("invalid_argument", "Missing value after `--timeout-ms`.");
      }

      const value = Number.parseInt(args[index], 10);
      if (!Number.isInteger(value) || value <= 0) {
        throw createCliError("invalid_argument", `Invalid timeout in ms: ${args[index]}`, {
          value: args[index]
        });
      }

      timeoutMs = value;
      continue;
    }

    throw createCliError("invalid_argument", `Unknown argument: ${arg}`, { argument: arg });
  }

  return { wait, timeout_ms: timeoutMs };
}

function parseRunCellArgs(args) {
  const { target, cellRef } = parseNotebookAndIndexArgs("run-cell", args);
  const text = args.includes("--print");
  const filteredArgs = args.filter((a) => a !== "--print");
  return {
    target,
    cellRef,
    text,
    ...parseExecutionOptions(filteredArgs, 2)
  };
}

function parseReplaceAndRunArgs(args) {
  const target = args[0];
  const cellIndexRaw = args[1];

  if (!target) {
    throw createCliError("invalid_argument", "Missing notebook URI or path for `replace-and-run`.");
  }

  if (cellIndexRaw === undefined) {
    throw createCliError("invalid_argument", "Missing cell index for `replace-and-run`.");
  }

  const cellRef = parseCellRef(cellIndexRaw, "cell index");
  let source;
  let timeoutMs = 30000;
  let save = false;
  let print = false;

  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--text") {
      index += 1;
      if (index >= args.length) {
        throw createCliError("invalid_argument", "Missing value after `--text`.");
      }
      source = args[index];
      continue;
    }

    if (arg === "--file") {
      index += 1;
      if (index >= args.length) {
        throw createCliError("invalid_argument", "Missing path after `--file`.");
      }
      source = readSourceFile(args[index]);
      continue;
    }

    if (arg === "--timeout-ms") {
      index += 1;
      if (index >= args.length) {
        throw createCliError("invalid_argument", "Missing value after `--timeout-ms`.");
      }
      const value = Number.parseInt(args[index], 10);
      if (!Number.isInteger(value) || value <= 0) {
        throw createCliError("invalid_argument", `Invalid timeout in ms: ${args[index]}`, { value: args[index] });
      }
      timeoutMs = value;
      continue;
    }

    if (arg === "--save") {
      save = true;
      continue;
    }

    if (arg === "--print") {
      print = true;
      continue;
    }

    throw createCliError("invalid_argument", `Unknown argument for \`replace-and-run\`: ${arg}`, { argument: arg });
  }

  if (source === undefined) {
    throw createCliError("invalid_argument", "Missing replacement content. Use `--text` or `--file`.");
  }

  return { target, cellRef, source, save, print, timeout_ms: timeoutMs };
}

function printCellOutputsAsText(cell) {
  const parts = [];
  for (const output of cell.outputs || []) {
    for (const item of output.items || []) {
      if (item.format === "text") {
        parts.push(item.text);
      } else if (item.format === "json" && item.mime === "application/vnd.code.notebook.error") {
        const err = item.json;
        const name = err.ename || err.name || "Error";
        const msg = err.evalue || err.message || "";
        parts.push(`${name}: ${msg}\n`);
        const tb = err.traceback;
        if (Array.isArray(tb)) {
          // Strip ANSI escape codes from Jupyter traceback lines
          parts.push(tb.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n") + "\n");
        }
      }
    }
  }
  return parts.join("");
}

function parseRunAllArgs(args) {
  const target = args[0];
  if (!target) {
    throw createCliError("invalid_argument", "Missing notebook URI or path for `run-all`.");
  }

  return {
    target,
    ...parseExecutionOptions(args, 1)
  };
}

async function runCommand(command, args) {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    success("help", { usage: usage() });
    return;
  }

  if (command === "bootstrap") {
    success("bootstrap", bootstrapBridge());
    return;
  }

  if (command === "doctor") {
    success("doctor", await doctor());
    return;
  }

  if (command === "status") {
    const instances = loadLiveInstances();
    const windows = await Promise.all(instances.map(async (instance) => {
      try {
        const health = await requestJson(instance, "/health", undefined, { timeoutMs: 4000 });
        return { ...describeInstance(instance), reachable: true, health };
      } catch (error) {
        return {
          ...describeInstance(instance),
          reachable: false,
          error: { code: error.code || "unexpected_error", message: error.message }
        };
      }
    }));
    success("status", { instance_count: instances.length, windows });
    return;
  }

  if (command === "list-open") {
    const instances = requireLiveInstances();
    const probes = await Promise.all(instances.map(probeInstance));
    success(command, {
      windows: probes.map(({ instance, reachable, notebooks, error }) => ({
        ...describeInstance(instance),
        reachable,
        notebooks: reachable ? notebooks : [],
        error: reachable ? null : { code: error.code || "unexpected_error", message: error.message }
      }))
    });
    return;
  }

  if (command === "new-notebook") {
    const instances = requireLiveInstances();
    const pathIndex = args.indexOf("--path");
    const filePath = pathIndex !== -1 ? args[pathIndex + 1] : undefined;
    if (pathIndex !== -1 && !filePath) {
      throw createCliError("invalid_argument", "Missing value after `--path`.");
    }
    const instance = resolveInstanceForNewNotebook(filePath, instances);
    const data = await requestJson(instance, "/new-notebook", filePath ? { file_path: filePath } : {});
    success(command, data);
    return;
  }

  if (!NOTEBOOK_TARGETED_COMMANDS.has(command)) {
    throw createCliError("unknown_command", `Unknown command: ${command}`, { command });
  }

  const instances = requireLiveInstances();
  const target = args[0];
  const instance = target ? await resolveInstanceForTarget(target, instances) : null;

  if (command === "inspect" || command === "list-cells") {
    parseNotebookTargetArg(command, args);
    const data = await readNotebookStructure(instance, target);
    success(command === "list-cells" ? "list-cells" : "inspect", data);
    return;
  }

  if (command === "get") {
    parseNotebookTargetArg("get", args);
    const data = await requestJson(instance, "/get", normalizeNotebookTarget(target));
    success(command, data);
    return;
  }

  if (command === "get-cell") {
    const { target, cellRef } = parseNotebookAndIndexArgs("get-cell", args);
    const data = await requestJson(instance, "/get-cell", {
      ...normalizeNotebookTarget(target),
      ...cellRef
    });
    success(command, data);
    return;
  }

  if (command === "get-outputs") {
    const { target, cellRef } = parseNotebookAndIndexArgs("get-outputs", args);
    const print = args.includes("--print");
    const data = await requestJson(instance, "/get-outputs", {
      ...normalizeNotebookTarget(target),
      ...cellRef
    });
    if (print) {
      if (data.cell?.execution_summary?.success === false) {
        process.stderr.write("execution failed\n");
      }
      process.stdout.write(printCellOutputsAsText(data.cell));
      return;
    }
    success(command, data);
    return;
  }

  if (command === "replace-cell") {
    const { target, cellRef, source, save } = parseReplaceCellArgs(args);
    const data = await requestJson(instance, "/replace-cell", {
      ...normalizeNotebookTarget(target),
      ...cellRef,
      source,
      save
    });
    success(command, data);
    return;
  }

  if (command === "patch-cell") {
    const { target, cellRef, oldSource, newSource, save } = parsePatchCellArgs(args);
    const cellData = await requestJson(instance, "/get-cell", {
      ...normalizeNotebookTarget(target),
      ...cellRef
    });
    const currentSource = cellData.cell?.source ?? cellData.source ?? "";
    const patchedSource = applyPatch(currentSource, oldSource, newSource);
    const data = await requestJson(instance, "/replace-cell", {
      ...normalizeNotebookTarget(target),
      ...cellRef,
      source: patchedSource,
      save
    });
    success(command, data);
    return;
  }

  if (command === "run-cell") {
    const { target, cellRef, wait, timeout_ms, text } = parseRunCellArgs(args);
    const data = await requestJson(instance, "/run-cell", {
      ...normalizeNotebookTarget(target),
      ...cellRef,
      wait,
      timeout_ms
    });
    if (text) {
      if (data.cell?.execution_summary?.success === false) {
        process.stderr.write("execution failed\n");
      }
      process.stdout.write(printCellOutputsAsText(data.cell));
      return;
    }
    success(command, data);
    return;
  }

  if (command === "replace-and-run") {
    const { target, cellRef, source, save, print, timeout_ms } = parseReplaceAndRunArgs(args);
    const data = await requestJson(instance, "/replace-and-run", {
      ...normalizeNotebookTarget(target),
      ...cellRef,
      source,
      save,
      timeout_ms
    });
    if (print) {
      if (data.cell?.execution_summary?.success === false) {
        process.stderr.write("execution failed\n");
      }
      process.stdout.write(printCellOutputsAsText(data.cell));
      return;
    }
    success(command, data);
    return;
  }

  if (command === "run-all") {
    const { target, wait, timeout_ms } = parseRunAllArgs(args);
    const data = await requestJson(instance, "/run-all", {
      ...normalizeNotebookTarget(target),
      wait,
      timeout_ms
    });
    success(command, data);
    return;
  }

  if (command === "add-cell") {
    const { target, cellIndex, kind, language, source, save } = parseAddCellArgs(args);
    const data = await requestJson(instance, "/add-cell", {
      ...normalizeNotebookTarget(target),
      cell_index: cellIndex,
      kind,
      language,
      source,
      save
    });
    success(command, data);
    return;
  }

  if (command === "delete-cell") {
    const { target, cellRef, save } = parseNotebookAndIndexArgs("delete-cell", args);
    const data = await requestJson(instance, "/delete-cell", {
      ...normalizeNotebookTarget(target),
      ...cellRef,
      save
    });
    success(command, data);
    return;
  }

  if (command === "find-error") {
    const target = parseNotebookTargetArg("find-error", args);
    const all = args.includes("--all");
    const data = await requestJson(instance, "/find-error", normalizeNotebookTarget(target));
    if (all) {
      success(command, {
        notebook_uri: data.notebook_uri,
        file_path: data.file_path,
        error_count: data.error_count,
        errors: data.errors
      });
      return;
    }
    success(command, {
      notebook_uri: data.notebook_uri,
      file_path: data.file_path,
      error_count: data.error_count,
      first_error: data.first_error
    });
    return;
  }

  throw createCliError("unknown_command", `Unknown command: ${command}`, { command });
}

module.exports = {
  isUnknownEndpointError,
  readNotebookStructure
};

async function main() {
  const [, , command, ...args] = process.argv;
  await runCommand(command, args);
}

if (require.main === module) {
  main().catch((error) => {
    fail(
      error.code || "unexpected_error",
      error.message || "Unexpected error.",
      error.details || null
    );
  });
}
