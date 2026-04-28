const test = require("node:test");
const assert = require("node:assert/strict");

const { readNotebookStructure } = require("../bin/nbctl.js");

test("readNotebookStructure falls back to legacy list-cells endpoint", async () => {
  const calls = [];
  const state = { port: 1234, token: "token" };
  const request = async (_state, endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === "/inspect") {
      const error = new Error("Unknown endpoint");
      error.code = "bridge_not_found";
      error.details = { endpoint: "/inspect" };
      throw error;
    }

    return { endpoint, payload };
  };

  const result = await readNotebookStructure(state, "/tmp/notebook.ipynb", request);

  assert.deepEqual(calls.map((call) => call.endpoint), ["/inspect", "/list-cells"]);
  assert.equal(result.endpoint, "/list-cells");
  assert.equal(result.payload.file_path, "/tmp/notebook.ipynb");
});

test("readNotebookStructure preserves non-endpoint errors", async () => {
  const request = async () => {
    const error = new Error("Boom");
    error.code = "bridge_internal_error";
    throw error;
  };

  await assert.rejects(
    readNotebookStructure({ port: 1234, token: "token" }, "/tmp/notebook.ipynb", request),
    /Boom/
  );
});
