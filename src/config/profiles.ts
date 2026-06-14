import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { log } from "../utils/logger.js";
import type { ConnectParams, TransportType } from "../connection/types.js";

// ── Profile Types ────────────────────────────────────────────────────────────

export interface ConnectionProfile {
  slug?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  confirmed: boolean;
  transportType?: TransportType;
  url?: string;
}

export interface NamedProfile {
  name: string;
  description?: string;
  connections: ConnectionProfile[];
}

export interface ProfileStore {
  /** Legacy flat list (also serves as the "default" profile) */
  connections: ConnectionProfile[];
  /** Named presets ("work", "personal", etc.) */
  profiles?: Record<string, NamedProfile>;
  /** Currently active named profile */
  activeProfile?: string;
}

const EMPTY_STORE: ProfileStore = { connections: [] };

// ── Load / Save ──────────────────────────────────────────────────────────────

export function loadProfiles(filePath: string): ProfileStore {
  if (!existsSync(filePath)) return { ...EMPTY_STORE, connections: [] };

  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as ProfileStore;
    if (!Array.isArray(data.connections)) {
      return { ...EMPTY_STORE, connections: [] };
    }
    log.debug("Loaded connection profiles", {
      count: data.connections.length,
      namedProfiles: data.profiles ? Object.keys(data.profiles).length : 0,
    });
    return data;
  } catch {
    log.warn("Failed to load profiles file, using empty store");
    return { ...EMPTY_STORE, connections: [] };
  }
}

export function saveProfiles(filePath: string, store: ProfileStore): void {
  try {
    writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    log.warn("Failed to save profiles", { error: String(err) });
  }
}

// ── Connection Profile CRUD ──────────────────────────────────────────────────

export function addProfile(filePath: string, params: ConnectParams): void {
  const store = loadProfiles(filePath);
  const identifier = params.slug || params.command || params.url;

  // Don't duplicate — update existing
  const idx = store.connections.findIndex(
    (p) =>
      (p.slug && p.slug === params.slug) ||
      (p.command && p.command === params.command) ||
      (p.url && p.url === params.url),
  );

  const profile: ConnectionProfile = {
    slug: params.slug,
    command: params.command,
    args: params.args,
    env: params.env,
    confirmed: params.confirmed ?? true,
    transportType: params.transportType,
    url: params.url,
  };

  if (idx >= 0) {
    store.connections[idx] = profile;
  } else {
    store.connections.push(profile);
  }

  saveProfiles(filePath, store);
  log.debug("Profile saved", { identifier });
}

export function removeProfile(filePath: string, slug: string): void {
  const store = loadProfiles(filePath);
  const before = store.connections.length;
  store.connections = store.connections.filter(
    (p) => p.slug !== slug && p.command !== slug,
  );
  if (store.connections.length < before) {
    saveProfiles(filePath, store);
    log.debug("Profile removed", { slug });
  }
}

// ── Named Profile Management ─────────────────────────────────────────────────

export function listNamedProfiles(filePath: string): NamedProfile[] {
  const store = loadProfiles(filePath);
  if (!store.profiles) return [];
  return Object.values(store.profiles);
}

export function getActiveProfileName(filePath: string): string | undefined {
  const store = loadProfiles(filePath);
  return store.activeProfile;
}

export function createNamedProfile(
  filePath: string,
  name: string,
  description?: string,
): void {
  const store = loadProfiles(filePath);
  if (!store.profiles) store.profiles = {};

  if (store.profiles[name]) {
    log.warn("Named profile already exists, overwriting", { name });
  }

  store.profiles[name] = {
    name,
    description,
    connections: [],
  };

  saveProfiles(filePath, store);
  log.info("Named profile created", { name });
}

export function deleteNamedProfile(filePath: string, name: string): boolean {
  const store = loadProfiles(filePath);
  if (!store.profiles || !store.profiles[name]) return false;

  delete store.profiles[name];

  // Clear active profile if it was deleted
  if (store.activeProfile === name) {
    store.activeProfile = undefined;
  }

  saveProfiles(filePath, store);
  log.info("Named profile deleted", { name });
  return true;
}

export function addToNamedProfile(
  filePath: string,
  profileName: string,
  params: ConnectParams,
): void {
  const store = loadProfiles(filePath);
  if (!store.profiles?.[profileName]) {
    throw new Error(`Named profile "${profileName}" does not exist.`);
  }

  const profile = store.profiles[profileName];

  // Don't duplicate
  const idx = profile.connections.findIndex(
    (p) =>
      (p.slug && p.slug === params.slug) ||
      (p.command && p.command === params.command) ||
      (p.url && p.url === params.url),
  );

  const connection: ConnectionProfile = {
    slug: params.slug,
    command: params.command,
    args: params.args,
    env: params.env,
    confirmed: params.confirmed ?? true,
    transportType: params.transportType,
    url: params.url,
  };

  if (idx >= 0) {
    profile.connections[idx] = connection;
  } else {
    profile.connections.push(connection);
  }

  saveProfiles(filePath, store);
}

export function removeFromNamedProfile(
  filePath: string,
  profileName: string,
  slug: string,
): void {
  const store = loadProfiles(filePath);
  if (!store.profiles?.[profileName]) return;

  const profile = store.profiles[profileName];
  profile.connections = profile.connections.filter(
    (p) => p.slug !== slug && p.command !== slug,
  );

  saveProfiles(filePath, store);
}

/**
 * Get the connections for a named profile.
 * Returns the default connections if no profile name is given.
 */
export function getProfileConnections(
  filePath: string,
  profileName?: string,
): ConnectionProfile[] {
  const store = loadProfiles(filePath);

  if (!profileName) {
    return store.connections;
  }

  if (!store.profiles?.[profileName]) {
    throw new Error(`Named profile "${profileName}" does not exist.`);
  }

  return store.profiles[profileName].connections;
}

/**
 * Set the active profile name.
 */
export function setActiveProfile(
  filePath: string,
  profileName: string | undefined,
): void {
  const store = loadProfiles(filePath);

  if (profileName && (!store.profiles || !store.profiles[profileName])) {
    throw new Error(`Named profile "${profileName}" does not exist.`);
  }

  store.activeProfile = profileName;
  saveProfiles(filePath, store);
}
