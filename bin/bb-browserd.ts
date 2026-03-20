#!/usr/bin/env bun

import { COMMAND_TIMEOUT, DAEMON_BASE_URL } from "../packages/shared/src/constants.ts";
import { generateId, type Request, type Response } from "../packages/shared/src/protocol.ts";

declare const process: {
  argv: string[];
  exit(code?: number): never;
  on(event: string, listener: (...args: unknown[]) => void): void;
};

const DEFAULT_PINIX_URL = "ws://127.0.0.1:9000/ws/capability";
const DEFAULT_CAPABILITY_NAME = "browser";
const RECONNECT_DELAY_MS = 5000;
const CAPABILITIES = [
  "navigate",
  "click",
  "type",
  "evaluate",
  "screenshot",
  "getCookies",
  "waitForSelector",
] as const;

type CapabilityCommand = (typeof CAPABILITIES)[number];
type InputObject = Record<string, unknown>;

interface Options {
  pinixUrl: string;
  name: string;
}

interface PinixRegisterMessage {
  type: "register";
  name: string;
  capabilities: readonly CapabilityCommand[];
}

interface PinixInvokeMessage {
  id: string;
  command: string;
  input?: InputObject;
}

interface PinixResultMessage {
  id: string;
  output?: unknown;
  error?: string;
}

interface CommandDefinition {
  buildRequest(input: InputObject): Omit<Request, "id">;
  transform(response: Response, input: InputObject): unknown;
}

const COMMAND_DEFINITIONS: Record<CapabilityCommand, CommandDefinition> = {
  navigate: {
    buildRequest(input) {
      return {
        action: "open",
        url: getRequiredString(input, "url"),
        tabId: getOptionalTabId(input),
      };
    },
    transform(response, input) {
      return {
        url: getResponseString(response.data?.url, getRequiredString(input, "url")),
        title: getResponseString(response.data?.title, ""),
      };
    },
  },
  click: {
    buildRequest(input) {
      return {
        action: "click",
        ref: getRequiredString(input, "selector", "ref"),
        tabId: getOptionalTabId(input),
      };
    },
    transform() {
      return {};
    },
  },
  type: {
    buildRequest(input) {
      return {
        action: "type",
        ref: getRequiredString(input, "selector", "ref"),
        text: getRequiredStringAllowEmpty(input, "text"),
        tabId: getOptionalTabId(input),
      };
    },
    transform() {
      return {};
    },
  },
  evaluate: {
    buildRequest(input) {
      return {
        action: "eval",
        script: getRequiredString(input, "js", "script"),
        tabId: getOptionalTabId(input),
      };
    },
    transform(response) {
      return { result: response.data?.result ?? null };
    },
  },
  screenshot: {
    buildRequest(input) {
      return {
        action: "screenshot",
        tabId: getOptionalTabId(input),
      };
    },
    transform(response) {
      const dataUrl = response.data?.dataUrl;
      if (typeof dataUrl !== "string" || dataUrl.length === 0) {
        throw new Error("Screenshot data missing from daemon response");
      }

      return { base64: stripDataUrlPrefix(dataUrl) };
    },
  },
  getCookies: {
    buildRequest(input) {
      return {
        action: "eval",
        script: "document.cookie",
        tabId: getOptionalTabId(input),
      };
    },
    transform(response) {
      const cookieString = response.data?.result;
      if (typeof cookieString !== "string") {
        throw new Error("Cookie string missing from daemon response");
      }

      return { cookies: parseCookies(cookieString) };
    },
  },
  waitForSelector: {
    buildRequest(input) {
      return {
        action: "wait",
        waitType: "element",
        ref: getRequiredString(input, "selector", "ref"),
        tabId: getOptionalTabId(input),
      };
    },
    transform() {
      return {};
    },
  },
};

function printUsage(): void {
  console.log(`Usage: bun run bin/bb-browserd.ts [--pinix <url>] [--name <name>]

Options:
  --pinix <url>  Pinix capability WebSocket URL (default: ${DEFAULT_PINIX_URL})
  --name <name>  Capability name to register (default: ${DEFAULT_CAPABILITY_NAME})
  --help         Show this message`);
}

function parseArgs(argv: string[]): Options {
  let pinixUrl = DEFAULT_PINIX_URL;
  let name = DEFAULT_CAPABILITY_NAME;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--pinix") {
      pinixUrl = getFlagValue(argv, index, "--pinix");
      index += 1;
      continue;
    }

    if (arg === "--name") {
      name = getFlagValue(argv, index, "--name");
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { pinixUrl, name };
}

function getFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function isCapabilityCommand(command: string): command is CapabilityCommand {
  return (CAPABILITIES as readonly string[]).includes(command);
}

function asInputObject(value: unknown): InputObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as InputObject;
}

function getRequiredString(input: InputObject, ...keys: string[]): string {
  return getRequiredStringInternal(input, keys, false);
}

function getRequiredStringAllowEmpty(input: InputObject, ...keys: string[]): string {
  return getRequiredStringInternal(input, keys, true);
}

function getRequiredStringInternal(input: InputObject, keys: string[], allowEmpty: boolean): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && (allowEmpty || value.trim().length > 0)) {
      return value;
    }
  }

  throw new Error(`Missing or invalid "${keys[0]}"`);
}

function getOptionalTabId(input: InputObject): string | number | undefined {
  const tabId = input.tabId;
  if (typeof tabId === "string" || typeof tabId === "number") {
    return tabId;
  }
  return undefined;
}

function getResponseString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function parseCookies(cookieString: string): Array<{ name: string; value: string }> {
  if (cookieString.trim().length === 0) {
    return [];
  }

  return cookieString
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex === -1) {
        return { name: part, value: "" };
      }

      return {
        name: part.slice(0, separatorIndex).trim(),
        value: part.slice(separatorIndex + 1).trim(),
      };
    })
    .filter((cookie) => cookie.name.length > 0);
}

function stripDataUrlPrefix(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(",");
  if (dataUrl.startsWith("data:") && commaIndex !== -1) {
    return dataUrl.slice(commaIndex + 1);
  }
  return dataUrl;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isPinixInvokeMessage(value: unknown): value is PinixInvokeMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && typeof candidate.command === "string";
}

function isPingMessage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return (value as Record<string, unknown>).type === "ping";
}

async function readTextMessage(data: unknown): Promise<string | null> {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }

  if (data instanceof Blob) {
    return data.text();
  }

  return null;
}

async function sendToDaemon(request: Request): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), COMMAND_TIMEOUT);

  try {
    const response = await fetch(`${DAEMON_BASE_URL}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    const rawBody = await response.text();
    clearTimeout(timeoutId);

    let parsedBody: unknown = null;
    if (rawBody.length > 0) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        return {
          id: request.id,
          success: false,
          error: `Daemon returned invalid JSON (HTTP ${response.status})`,
        };
      }
    }

    if (parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)) {
      return parsedBody as Response;
    }

    return {
      id: request.id,
      success: false,
      error: response.ok
        ? "Daemon returned an empty response"
        : `Daemon request failed with HTTP ${response.status}`,
    };
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === "AbortError") {
      return {
        id: request.id,
        success: false,
        error: `Daemon request timed out after ${COMMAND_TIMEOUT}ms`,
      };
    }

    return {
      id: request.id,
      success: false,
      error: `Failed to reach bb-browser daemon at ${DAEMON_BASE_URL}: ${formatError(error)}`,
    };
  }
}

async function executeCommand(command: CapabilityCommand, input: InputObject): Promise<unknown> {
  const definition = COMMAND_DEFINITIONS[command];
  const request: Request = {
    id: generateId(),
    ...definition.buildRequest(input),
  };

  const response = await sendToDaemon(request);
  if (!response.success) {
    throw new Error(response.error || `Daemon action "${request.action}" failed`);
  }

  return definition.transform(response, input);
}

class PinixBridge {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly options: Options) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket && this.socket.readyState !== WebSocket.CLOSING && this.socket.readyState !== WebSocket.CLOSED) {
      this.socket.close();
    }
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }

    if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) {
      return;
    }

    console.log(`[bb-browserd] Connecting to ${this.options.pinixUrl}`);
    let socket: WebSocket;

    try {
      socket = new WebSocket(this.options.pinixUrl);
    } catch (error) {
      console.error(`[bb-browserd] Failed to create WebSocket: ${formatError(error)}`);
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) {
        return;
      }

      console.log(`[bb-browserd] Connected to pinixd at ${this.options.pinixUrl}`);
      this.clearReconnectTimer();
      this.register(socket);
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket) {
        return;
      }

      void this.handleMessage(socket, event.data);
    };

    socket.onerror = () => {
      if (this.socket !== socket) {
        return;
      }

      console.error("[bb-browserd] WebSocket error");
    };

    socket.onclose = (event) => {
      if (this.socket === socket) {
        this.socket = null;
      }

      const details = event.reason ? ` ${event.code} ${event.reason}` : ` ${event.code}`;
      console.error(`[bb-browserd] Disconnected from pinixd:${details}`);

      if (!this.stopped) {
        this.scheduleReconnect();
      }
    };
  }

  private register(socket: WebSocket): void {
    const message: PinixRegisterMessage = {
      type: "register",
      name: this.options.name,
      capabilities: CAPABILITIES,
    };

    if (this.send(socket, message)) {
      console.log(
        `[bb-browserd] Registered capability "${this.options.name}" with commands: ${CAPABILITIES.join(", ")}`,
      );
    }
  }

  private async handleMessage(socket: WebSocket, rawData: unknown): Promise<void> {
    const text = await readTextMessage(rawData);
    if (text === null) {
      console.error("[bb-browserd] Ignoring non-text WebSocket message");
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch (error) {
      console.error(`[bb-browserd] Failed to parse message: ${formatError(error)}`);
      return;
    }

    if (isPingMessage(message)) {
      this.send(socket, { type: "pong" });
      return;
    }

    if (!isPinixInvokeMessage(message)) {
      return;
    }

    await this.handleInvocation(socket, message);
  }

  private async handleInvocation(socket: WebSocket, message: PinixInvokeMessage): Promise<void> {
    if (!isCapabilityCommand(message.command)) {
      this.sendError(socket, message.id, `Unknown capability command: ${message.command}`);
      return;
    }

    try {
      const output = await executeCommand(message.command, asInputObject(message.input));
      this.send(socket, { id: message.id, output } satisfies PinixResultMessage);
    } catch (error) {
      this.sendError(socket, message.id, formatError(error));
    }
  }

  private sendError(socket: WebSocket, id: string, error: string): void {
    this.send(socket, { id, error } satisfies PinixResultMessage);
  }

  private send(socket: WebSocket, payload: PinixRegisterMessage | PinixResultMessage | { type: "pong" }): boolean {
    if (socket.readyState !== WebSocket.OPEN) {
      console.error("[bb-browserd] Socket is not open; dropping outbound message");
      return false;
    }

    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      console.error(`[bb-browserd] Failed to send message: ${formatError(error)}`);
      return false;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) {
      return;
    }

    console.log(`[bb-browserd] Reconnecting in ${RECONNECT_DELAY_MS}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

function installProcessHandlers(bridge: PinixBridge): void {
  process.on("SIGINT", () => {
    bridge.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    bridge.stop();
    process.exit(0);
  });

  process.on("unhandledRejection", (reason) => {
    console.error(`[bb-browserd] Unhandled rejection: ${formatError(reason)}`);
  });

  process.on("uncaughtException", (error) => {
    console.error(`[bb-browserd] Uncaught exception: ${formatError(error)}`);
  });
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const bridge = new PinixBridge(options);

  installProcessHandlers(bridge);
  bridge.start();
}

try {
  main();
} catch (error) {
  console.error(`[bb-browserd] ${formatError(error)}`);
  process.exit(1);
}
