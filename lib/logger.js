const fs = require("fs");
const path = require("path");

const MAX_BYTES = 2 * 1024 * 1024;

function maybeRotate(filePath) {
  try {
    if (fs.statSync(filePath).size >= MAX_BYTES) {
      fs.renameSync(filePath, filePath + ".1");
    }
  } catch {
    // File doesn't exist yet or stat failed — nothing to rotate
  }
}

function writeLine(filePath, line) {
  try {
    maybeRotate(filePath);
    fs.appendFileSync(filePath, line + "\n", "utf8");
  } catch {
    // Logging must never crash the extension
  }
}

function fmt(level, message) {
  return `${new Date().toISOString()} ${level.padEnd(5)} ${message}`;
}

function notebookLabel(uri) {
  if (!uri) return "";
  return path.basename(decodeURIComponent(uri));
}

function createLogger(filePath) {
  return {
    filePath,

    info(message) {
      writeLine(filePath, fmt("INFO", message));
    },

    error(message) {
      writeLine(filePath, fmt("ERROR", message));
    },

    request(url, body) {
      const nb = notebookLabel(body.notebook_uri || body.file_path);
      const cell = body.cell_index != null ? ` cell=${body.cell_index}` : "";
      const detail = nb ? ` nb=${nb}${cell}` : "";
      writeLine(filePath, fmt("REQ", `${url}${detail}`));
    },

    response(url, statusCode, ms, errorMessage) {
      const err = errorMessage ? ` "${errorMessage}"` : "";
      writeLine(filePath, fmt("RES", `${url} ${statusCode} ${ms}ms${err}`));
    }
  };
}

module.exports = { createLogger };
