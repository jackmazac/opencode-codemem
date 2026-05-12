declare namespace NodeJS {
  type Timeout = number;
  interface Process {
    argv: string[];
    env: Record<string, string | undefined>;
    platform: string;
    arch: string;
    cwd(): string;
    exit(code?: number): never;
    kill(pid: number, signal?: number | string): void;
  }
}

interface ImportMeta {
  main?: boolean;
}

declare const process: NodeJS.Process;
declare class Buffer extends Uint8Array {
  static from(data: string | ArrayBufferView, encoding?: string): Buffer;
  static allocUnsafe(size: number): Buffer;
  static alloc(size: number): Buffer;
  static concat(list: readonly Uint8Array[]): Buffer;
  writeUInt32BE(value: number, offset: number): number;
  readUInt32BE(offset: number): number;
  subarray(start?: number, end?: number): Buffer;
  toString(encoding?: string): string;
  readonly length: number;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(p: string): string;
  const path: {
    join(...parts: string[]): string;
    resolve(...parts: string[]): string;
    dirname(p: string): string;
    relative(from: string, to: string): string;
    normalize(p: string): string;
    isAbsolute(p: string): boolean;
  };
  export = path;
}

declare module "node:fs/promises" {
  export type Stats = { isFile(): boolean; isDirectory(): boolean };
  export function readFile(path: string, encoding: string): Promise<string>;
  export function writeFile(path: string, data: string, options?: { mode?: number }): Promise<void>;
  export function appendFile(path: string, data: string): Promise<void>;
  export function stat(path: string): Promise<Stats>;
  export function rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

declare module "node:fs" {
  export function appendFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  const fs: {
    readFileSync(path: string, encoding: string): string;
    appendFileSync: typeof appendFileSync;
    existsSync: typeof existsSync;
    mkdirSync: typeof mkdirSync;
  };
  export default fs;
}

declare module "node:crypto" {
  export function randomUUID(): string;
  export function randomBytes(size: number): { toString(encoding: string): string };
  export function createHash(
    algorithm: string,
  ): { update(input: string): { digest(encoding: string): string } };
}

declare module "node:os" {
  export function tmpdir(): string;
  export function homedir(): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare module "node:events" {
  export function once(
    emitter: { once(event: string, cb: (...args: unknown[]) => void): void },
    event: string,
  ): Promise<unknown[]>;
}

declare module "node:net" {
  export interface Socket {
    once(event: "connect", cb: () => void): this;
    once(event: "error", cb: (error: Error) => void): this;
    once(event: "close", cb: (hadError: boolean) => void): this;
    on(event: "data", cb: (chunk: Buffer) => void): this;
    setTimeout(timeout: number): this;
    setNoDelay(noDelay?: boolean): this;
    write(data: string | Uint8Array): boolean;
    destroy(error?: Error): void;
  }
  export function createConnection(path: string): Socket;
  const net: { createConnection: typeof createConnection };
  export default net;
}


declare const Bun: {
  stdin: { text(): Promise<string> };
  spawn(options: {
    cmd: string[];
    cwd: string;
    env: Record<string, string | undefined>;
    detached: boolean;
    stdin: "ignore";
    stdout: "ignore";
    stderr: "ignore";
  }): { pid: number };
};
