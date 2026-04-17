import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const BASE_URL = "http://127.0.0.1:21519";

function getTokenPath(): string {
  if (process.env.SHIBEI_DATA_DIR) {
    return join(process.env.SHIBEI_DATA_DIR, "mcp-token");
  }
  // OS-specific default data directory
  if (process.platform === "win32") {
    // Windows: %LOCALAPPDATA%/shibei/ (matches dirs::data_local_dir)
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(localAppData, "shibei", "mcp-token");
  }
  // macOS: ~/Library/Application Support/shibei/
  return join(homedir(), "Library", "Application Support", "shibei", "mcp-token");
}

function readToken(): string {
  try {
    return readFileSync(getTokenPath(), "utf-8").trim();
  } catch {
    throw new Error("Shibei app is not running. Please start the app first.");
  }
}

export class ShibeiClient {
  private token: string;

  constructor() {
    this.token = readToken();
  }

  private async doFetch(url: string, method: string, body?: unknown): Promise<Response> {
    return fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${BASE_URL}${path}`;
    let response: Response;
    try {
      response = await this.doFetch(url, method, body);
    } catch {
      throw new Error("Shibei app is not running. Please start the app first.");
    }

    // Token rotated (app restart). Re-read token file and retry once.
    if (response.status === 401) {
      try {
        this.token = readToken();
      } catch {
        throw new Error("Authentication failed. Shibei app may not be running.");
      }
      response = await this.doFetch(url, method, body);
      if (response.status === 401) {
        throw new Error("Authentication failed. Please restart Shibei app.");
      }
    }

    if (!response.ok) {
      const err = (await response.json().catch(() => ({ error: `HTTP ${response.status}` }))) as { error: string };
      throw new Error(err.error);
    }

    return (await response.json()) as T;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}
