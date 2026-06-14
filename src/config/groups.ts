import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { log } from "../utils/logger.js";
import type { ConnectParams, TransportType } from "../connection/types.js";

// ── Group Types ──────────────────────────────────────────────────────────────

export interface ServerGroupEntry {
  slug?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transportType?: TransportType;
  url?: string;
}

export interface ServerGroup {
  name: string;
  description?: string;
  servers: ServerGroupEntry[];
}

export interface GroupStore {
  groups: Record<string, ServerGroup>;
}

const EMPTY_STORE: GroupStore = { groups: {} };

// ── Load / Save ──────────────────────────────────────────────────────────────

export function loadGroups(filePath: string): GroupStore {
  if (!existsSync(filePath)) return { ...EMPTY_STORE, groups: {} };

  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as GroupStore;
    if (!data.groups || typeof data.groups !== "object") {
      return { ...EMPTY_STORE, groups: {} };
    }
    return data;
  } catch {
    log.warn("Failed to load groups file, using empty store");
    return { ...EMPTY_STORE, groups: {} };
  }
}

export function saveGroups(filePath: string, store: GroupStore): void {
  try {
    writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    log.warn("Failed to save groups", { error: String(err) });
  }
}

// ── Group CRUD ───────────────────────────────────────────────────────────────

export function createGroup(
  filePath: string,
  name: string,
  description?: string,
): void {
  const store = loadGroups(filePath);

  if (store.groups[name]) {
    log.warn("Group already exists, overwriting", { name });
  }

  store.groups[name] = {
    name,
    description,
    servers: [],
  };

  saveGroups(filePath, store);
  log.info("Server group created", { name });
}

export function deleteGroup(filePath: string, name: string): boolean {
  const store = loadGroups(filePath);
  if (!store.groups[name]) return false;

  delete store.groups[name];
  saveGroups(filePath, store);
  log.info("Server group deleted", { name });
  return true;
}

export function listGroups(filePath: string): ServerGroup[] {
  const store = loadGroups(filePath);
  return Object.values(store.groups);
}

export function getGroup(filePath: string, name: string): ServerGroup | undefined {
  const store = loadGroups(filePath);
  return store.groups[name];
}

export function addToGroup(
  filePath: string,
  groupName: string,
  server: ServerGroupEntry,
): void {
  const store = loadGroups(filePath);
  const group = store.groups[groupName];
  if (!group) {
    throw new Error(`Server group "${groupName}" does not exist.`);
  }

  const identifier = server.slug || server.command || server.url;

  // Don't duplicate
  const existing = group.servers.findIndex(
    (s) =>
      (s.slug && s.slug === server.slug) ||
      (s.command && s.command === server.command) ||
      (s.url && s.url === server.url),
  );

  if (existing >= 0) {
    group.servers[existing] = server;
  } else {
    group.servers.push(server);
  }

  saveGroups(filePath, store);
  log.debug("Server added to group", { group: groupName, identifier });
}

export function removeFromGroup(
  filePath: string,
  groupName: string,
  slugOrCommand: string,
): void {
  const store = loadGroups(filePath);
  const group = store.groups[groupName];
  if (!group) return;

  group.servers = group.servers.filter(
    (s) => s.slug !== slugOrCommand && s.command !== slugOrCommand && s.url !== slugOrCommand,
  );

  saveGroups(filePath, store);
}

/**
 * Convert a group's servers to ConnectParams for connecting.
 */
export function groupToConnectParams(group: ServerGroup): ConnectParams[] {
  return group.servers.map((s) => ({
    slug: s.slug,
    command: s.command,
    args: s.args,
    env: s.env,
    transportType: s.transportType,
    url: s.url,
    confirmed: true,
  }));
}
