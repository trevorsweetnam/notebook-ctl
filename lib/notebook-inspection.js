const crypto = require("crypto");

function decodeOutputItemData(item) {
  if (!item || typeof item.data === "undefined" || item.data === null) {
    return null;
  }

  const mime = item.mime || "application/octet-stream";
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

function outputByteLength(output) {
  return (output.items || []).reduce((total, item) => {
    if (!item || typeof item.data === "undefined" || item.data === null) {
      return total;
    }
    return total + Buffer.from(item.data).length;
  }, 0);
}

function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function summarizeOutputItem(item) {
  const decoded = decodeOutputItemData(item);
  if (!decoded) {
    return null;
  }

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

function summarizeCell(cell, index, kindFromVsCode) {
  const source = cell.document?.getText ? cell.document.getText() : String(cell.source || "");
  const firstLine = source.split(/\r?\n/, 1)[0] || "";
  const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
  const normalizedOutputs = outputs.map((output) => ({
    items: Array.isArray(output.items) ? output.items : [],
    metadata: output.metadata || {}
  }));
  const outputCount = normalizedOutputs.length;
  const outputMimeTypes = [
    ...new Set(normalizedOutputs.flatMap((output) => output.items.map((item) => item && item.mime).filter(Boolean)))
  ];
  const firstOutputItem = normalizedOutputs
    .flatMap((output) => output.items)
    .find(Boolean) || null;

  return {
    id: `c${index}`,
    index,
    kind: kindFromVsCode || cell.kind || "code",
    language: cell.document?.languageId || cell.language || "python",
    preview: firstLine.slice(0, 120),
    source_length: source.length,
    source_sha256: hashText(source),
    execution_summary: cell.executionSummary || null,
    has_outputs: outputCount > 0,
    output_count: outputCount,
    output_bytes: normalizedOutputs.reduce((total, output) => total + outputByteLength(output), 0),
    output_mime_types: outputMimeTypes,
    output_preview: firstOutputItem ? summarizeOutputItem(firstOutputItem) : null
  };
}

module.exports = {
  decodeOutputItemData,
  hashText,
  outputByteLength,
  summarizeCell,
  summarizeOutputItem
};
