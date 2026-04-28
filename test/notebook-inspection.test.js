const test = require("node:test");
const assert = require("node:assert/strict");

const { summarizeCell } = require("../lib/notebook-inspection");

test("summarizeCell tolerates malformed notebook outputs", () => {
  const cell = {
    source: "print('hello')",
    language: "python",
    outputs: [
      {
        items: [{}]
      },
      {
        items: []
      }
    ]
  };

  assert.doesNotThrow(() => summarizeCell(cell, 3, "code"));

  const summary = summarizeCell(cell, 3, "code");
  assert.equal(summary.id, "c3");
  assert.equal(summary.output_count, 2);
  assert.equal(summary.output_bytes, 0);
  assert.equal(summary.output_preview, null);
});

test("summarizeCell includes text output previews when data exists", () => {
  const cell = {
    source: "print('hello')",
    language: "python",
    outputs: [
      {
        items: [
          {
            mime: "text/plain",
            data: Buffer.from("hello world")
          }
        ]
      }
    ]
  };

  const summary = summarizeCell(cell, 0, "code");
  assert.equal(summary.output_count, 1);
  assert.equal(summary.output_preview.text_preview, "hello world");
  assert.equal(summary.output_bytes, Buffer.byteLength("hello world"));
});

test("summarizeCell handles multiple outputs and mime types", () => {
  const cell = {
    source: "print('hello')",
    language: "python",
    outputs: [
      {
        items: [
          {
            mime: "text/plain",
            data: Buffer.from("first")
          }
        ]
      },
      {
        items: [
          {
            mime: "application/json",
            data: Buffer.from(JSON.stringify({ answer: 42 }))
          }
        ]
      }
    ]
  };

  const summary = summarizeCell(cell, 1, "code");
  assert.equal(summary.output_count, 2);
  assert.deepEqual(summary.output_mime_types.sort(), ["application/json", "text/plain"]);
  assert.equal(summary.output_bytes, Buffer.byteLength("first") + Buffer.byteLength(JSON.stringify({ answer: 42 })));
  assert.equal(summary.output_preview.text_preview, "first");
});
