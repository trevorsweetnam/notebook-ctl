const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const registry = require("../lib/instance-registry");

function tempStatePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nbctl-registry-")), "state.json");
}

test("upsertInstance replaces only the matching pid", () => {
  const existing = [
    { pid: 1, port: 100 },
    { pid: 2, port: 200 }
  ];
  const next = registry.upsertInstance(existing, { pid: 2, port: 999 });
  assert.deepEqual(
    next.sort((a, b) => a.pid - b.pid),
    [{ pid: 1, port: 100 }, { pid: 2, port: 999 }]
  );
});

test("removeInstancePid removes only the target pid", () => {
  const existing = [
    { pid: 1, port: 100 },
    { pid: 2, port: 200 }
  ];
  const next = registry.removeInstancePid(existing, 1);
  assert.deepEqual(next, [{ pid: 2, port: 200 }]);
});

test("pruneDeadInstances filters using an injected liveness function", () => {
  const existing = [{ pid: 1 }, { pid: 2 }, { pid: 3 }];
  const next = registry.pruneDeadInstances(existing, (pid) => pid !== 2);
  assert.deepEqual(next, [{ pid: 1 }, { pid: 3 }]);
});

test("readInstancesFile tolerates a missing file", () => {
  const filePath = path.join(os.tmpdir(), `nbctl-missing-${process.pid}-${Math.floor(Math.random() * 1e6)}.json`);
  assert.deepEqual(registry.readInstancesFile(filePath), []);
});

test("readInstancesFile tolerates corrupt JSON", () => {
  const filePath = tempStatePath();
  fs.writeFileSync(filePath, "{ not valid json");
  assert.deepEqual(registry.readInstancesFile(filePath), []);
});

test("readInstancesFile tolerates an old flat-shaped state file", () => {
  const filePath = tempStatePath();
  fs.writeFileSync(filePath, JSON.stringify({ port: 1234, token: "abc" }));
  assert.deepEqual(registry.readInstancesFile(filePath), []);
});

test("writeInstancesFile then readInstancesFile round-trips", () => {
  const filePath = tempStatePath();
  const instances = [{ pid: 1, port: 100 }];
  assert.equal(registry.writeInstancesFile(filePath, instances), true);
  assert.deepEqual(registry.readInstancesFile(filePath), instances);
});

test("writeInstancesFile deletes the file when instances is empty", () => {
  const filePath = tempStatePath();
  registry.writeInstancesFile(filePath, [{ pid: 1, port: 100 }]);
  assert.equal(fs.existsSync(filePath), true);
  registry.writeInstancesFile(filePath, []);
  assert.equal(fs.existsSync(filePath), false);
});

test("isPidAlive returns true for the current process", () => {
  assert.equal(registry.isPidAlive(process.pid), true);
});

test("isPidAlive returns false for a pid that does not exist", () => {
  assert.equal(registry.isPidAlive(999999), false);
});
