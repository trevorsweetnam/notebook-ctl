#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");

const LEGACY_STATE_FILE_PATHS = [
  path.resolve(__dirname, "..", ".nbctl-state.json")
];

const CODE_CLI_CANDIDATES = [
  process.env.NBCTL_CODE_CLI,
  "code",
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
].filter(Boolean);

function defaultStateFilePath() {
  return path.join(os.homedir(), ".notebook-bridge", "state.json");
}

function usage() {
  return `Usage:
  nbctl list-open
  nbctl inspect <notebook-uri-or-path>
  nbctl list-cells <notebook-uri-or-path>   (alias for inspect)
  nbctl get <notebook-uri-or-path>
  nbctl get-cell <notebook-uri-or-path> <cell-index>
  nbctl get-outputs <notebook-uri-or-path> <cell-index>
  nbctl run-cell <notebook-uri-or-path> <cell-index> [--wait] [--timeout-ms <ms>]
  nbctl run-all <notebook-uri-or-path> [--wait] [--timeout-ms <ms>]
  nbctl replace-cell <notebook-uri-or-path> <cell-index> (--text <text> | --file <path>)
  nbctl add-cell <notebook-uri-or-path> <insert-index> --kind <code|markdown> [--language <id>] (--text <text> | --file <path>)
  nbctl delete-cell <notebook-uri-or-path> <cell-index>
  nbctl bootstrap
  nbctl doctor
  nbctl status
  nbctl help

Environment:
  NBCTL_STATE_FILE   Override the bridge state file path.
  NBCTL_CODE_CLI     Override the VS Code CLI executable used by bootstrap.
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

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function findStateFilePath() {
  if (process.env.NBCTL_STATE_FILE) {
    return process.env.NBCTL_STATE_FILE;
  }

  const candidates = [defaultStateFilePath()].concat(LEGACY_STATE_FILE_PATHS);
  return candidates.find((candidate) => fs.existsSync(candidate));
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

async function doctor() {
  const stateFile = findStateFilePath();
  const result = {
    state_candidates: [defaultStateFilePath()].concat(LEGACY_STATE_FILE_PATHS),
    state_file: stateFile || null,
    state_exists: Boolean(stateFile),
    code_cli: findCodeCli(),
    code_cli_candidates: CODE_CLI_CANDIDATES,
    bundled_vsix: bundledVsixPath(),
    bundled_vsix_exists: fs.existsSync(bundledVsixPath()),
    health: null
  };

  if (stateFile) {
    try {
      const state = loadState();
      result.state = {
        extension_path: state.extension_path || null,
        port: state.port || null,
        updated_at: state.updated_at || null
      };
      result.health = await requestJson(state, "/health");
    } catch (error) {
      result.health = {
        ok: false,
        code: error.code || "unexpected_error",
        message: error.message,
        details: error.details || null
      };
    }
  }

  return result;
}

function loadState() {
  const stateFile = findStateFilePath();
  if (!stateFile) {
    const defaultPath = defaultStateFilePath();
    throw createCliError(
      "bridge_not_available",
      "Notebook Bridge state file was not found. Run `nbctl bootstrap`, then reload/open VS Code so the extension can start.",
      {
        looked_in: [defaultPath].concat(LEGACY_STATE_FILE_PATHS),
        env_var: "NBCTL_STATE_FILE",
        bootstrap_command: "nbctl bootstrap",
        diagnostic_command: "nbctl doctor"
      }
    );
  }

  try {
    const state = readJsonFile(stateFile);
    state.state_file = stateFile;
    return state;
  } catch (error) {
    throw createCliError(
      "invalid_state_file",
      `Failed to read Notebook Bridge state file at ${stateFile}.`,
      { state_file: stateFile, reason: error.message }
    );
  }
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

function requestJson(state, endpoint, payload) {
  const requestBody = endpoint === "/health" ? undefined : JSON.stringify(payload || {});

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: state.port,
      path: endpoint,
      method: endpoint === "/health" ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${state.token}`,
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
              { endpoint, reason: error.message, body }
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
              state_file: state.state_file
            }
          ));
          return;
        }

        resolve(data);
      });
    });

    req.on("error", (error) => {
      if (error.code === "ECONNREFUSED") {
        reject(createCliError(
          "bridge_not_listening",
          `Notebook Bridge is not listening on 127.0.0.1:${state.port}. Open VS Code and run 'Notebook Bridge: Show Server Info' again.`,
          {
            port: state.port,
            state_file: state.state_file
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
          state_file: state.state_file
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

function readSourceFile(filePath) {
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

  return {
    target,
    cellIndex: parseCellIndex(cellIndexRaw, "cell index"),
    source: parseSourceOption(args, 2)
  };
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

    throw createCliError("invalid_argument", `Unknown argument for \`add-cell\`: ${arg}`, { argument: arg });
  }

  if (kind !== "code" && kind !== "markdown") {
    throw createCliError("invalid_argument", "Cell kind must be `code` or `markdown`.");
  }

  if (source === undefined) {
    throw createCliError("invalid_argument", "Missing new cell content. Use `--text` or `--file`.");
  }

  return { target, cellIndex, kind, language, source };
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
    cellIndex: parseCellIndex(cellIndexRaw, "cell index")
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
  const { target, cellIndex } = parseNotebookAndIndexArgs("run-cell", args);
  return {
    target,
    cellIndex,
    ...parseExecutionOptions(args, 2)
  };
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

  const state = loadState();

  if (command === "status") {
    const health = await requestJson(state, "/health");
    success("status", {
      state_file: state.state_file,
      extension_path: state.extension_path,
      port: state.port,
      updated_at: state.updated_at || null,
      health
    });
    return;
  }

  await requestJson(state, "/health");

  if (command === "list-open") {
    const data = await requestJson(state, "/list-open", {});
    success(command, data);
    return;
  }

  if (command === "inspect" || command === "list-cells") {
    const target = parseNotebookTargetArg(command, args);
    const data = await readNotebookStructure(state, target);
    success(command === "list-cells" ? "list-cells" : "inspect", data);
    return;
  }

  if (command === "get") {
    const target = parseNotebookTargetArg("get", args);
    const data = await requestJson(state, "/get", normalizeNotebookTarget(target));
    success(command, data);
    return;
  }

  if (command === "get-cell") {
    const { target, cellIndex } = parseNotebookAndIndexArgs("get-cell", args);
    const data = await requestJson(state, "/get-cell", {
      ...normalizeNotebookTarget(target),
      cell_index: cellIndex
    });
    success(command, data);
    return;
  }

  if (command === "get-outputs") {
    const { target, cellIndex } = parseNotebookAndIndexArgs("get-outputs", args);
    const data = await requestJson(state, "/get-outputs", {
      ...normalizeNotebookTarget(target),
      cell_index: cellIndex
    });
    success(command, data);
    return;
  }

  if (command === "replace-cell") {
    const { target, cellIndex, source } = parseReplaceCellArgs(args);
    const data = await requestJson(state, "/replace-cell", {
      ...normalizeNotebookTarget(target),
      cell_index: cellIndex,
      source
    });
    success(command, data);
    return;
  }

  if (command === "run-cell") {
    const { target, cellIndex, wait, timeout_ms } = parseRunCellArgs(args);
    const data = await requestJson(state, "/run-cell", {
      ...normalizeNotebookTarget(target),
      cell_index: cellIndex,
      wait,
      timeout_ms
    });
    success(command, data);
    return;
  }

  if (command === "run-all") {
    const { target, wait, timeout_ms } = parseRunAllArgs(args);
    const data = await requestJson(state, "/run-all", {
      ...normalizeNotebookTarget(target),
      wait,
      timeout_ms
    });
    success(command, data);
    return;
  }

  if (command === "add-cell") {
    const { target, cellIndex, kind, language, source } = parseAddCellArgs(args);
    const data = await requestJson(state, "/add-cell", {
      ...normalizeNotebookTarget(target),
      cell_index: cellIndex,
      kind,
      language,
      source
    });
    success(command, data);
    return;
  }

  if (command === "delete-cell") {
    const { target, cellIndex } = parseNotebookAndIndexArgs("delete-cell", args);
    const data = await requestJson(state, "/delete-cell", {
      ...normalizeNotebookTarget(target),
      cell_index: cellIndex
    });
    success(command, data);
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
