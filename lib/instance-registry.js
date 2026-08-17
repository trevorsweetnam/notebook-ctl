const fs = require("fs");
const os = require("os");
const path = require("path");

function primaryStatePath() {
  return path.join(os.homedir(), ".notebook-bridge", "state.json");
}

function legacyStatePath() {
  return path.join(__dirname, "..", ".nbctl-state.json");
}

function statePaths() {
  return [primaryStatePath(), legacyStatePath()];
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid)) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readInstancesFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.instances)) {
      return parsed.instances;
    }
    return [];
  } catch {
    return [];
  }
}

function writeInstancesFile(filePath, instances) {
  try {
    if (instances.length === 0) {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          return false;
        }
      }
      return true;
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify({ instances }, null, 2));
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch {
    return false;
  }
}

function loadInstances({ statePath } = {}) {
  if (statePath) {
    return readInstancesFile(statePath);
  }

  const primary = readInstancesFile(primaryStatePath());
  if (primary.length > 0) {
    return primary;
  }

  return readInstancesFile(legacyStatePath());
}

function pruneDeadInstances(instances, isAliveFn = isPidAlive) {
  return instances.filter((instance) => isAliveFn(instance.pid));
}

function upsertInstance(instances, record) {
  return [...instances.filter((instance) => instance.pid !== record.pid), record];
}

function removeInstancePid(instances, pid) {
  return instances.filter((instance) => instance.pid !== pid);
}

function writeInstances(instances) {
  const written = [];
  const errors = [];

  for (const filePath of statePaths()) {
    if (writeInstancesFile(filePath, instances)) {
      written.push(filePath);
    } else {
      errors.push(filePath);
    }
  }

  return { written, errors };
}

module.exports = {
  primaryStatePath,
  legacyStatePath,
  statePaths,
  isPidAlive,
  readInstancesFile,
  writeInstancesFile,
  loadInstances,
  pruneDeadInstances,
  upsertInstance,
  removeInstancePid,
  writeInstances
};
