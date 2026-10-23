/**
 * Performs the actual `git push` using a short-lived installation token
 * minted by /api/bridge/git-token (mission-git-credential-broker.ts).
 *
 * The token is deliberately not put in the remote URL, command arguments,
 * environment, git config, or a file. Git receives it only in response to
 * its own askpass request over a random, short-lived local pipe owned by this
 * process. The helper file contains only the pipe name and is removed in the
 * finally block.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ASKPASS_HELPER_SOURCE = `
const net = require("node:net");
const pipePath = process.argv[2];
const prompt = process.argv.slice(3).join(" ").toLowerCase();
if (!pipePath) process.exit(1);
const socket = net.createConnection(pipePath);
let reply = "";
socket.on("connect", () => socket.end(prompt.includes("username") ? "username" : "password"));
socket.on("data", (chunk) => { reply += chunk.toString(); });
socket.on("end", () => process.stdout.write(reply));
socket.on("error", () => process.exit(1));
`;

interface AskpassChannel {
  command: string;
  server: Server;
  directory: string;
}

async function openAskpassChannel(token: string): Promise<AskpassChannel> {
  const directory = await mkdtemp(join(tmpdir(), "m9r-git-askpass-"));
  let server: Server | undefined;
  try {
    const pipePath = process.platform === "win32"
      ? `\\\\.\\pipe\\m9r-git-askpass-${randomUUID()}`
      : join(directory, "credential.sock");
    const helperPath = join(directory, "askpass.cjs");
    await writeFile(helperPath, ASKPASS_HELPER_SOURCE, { encoding: "utf8", flag: "wx" });
    let command = helperPath;

    if (process.platform === "win32") {
      const commandPath = join(directory, "askpass.cmd");
      const nodePath = process.execPath.replaceAll("%", "%%").replaceAll("\"", "\"\"");
      const helperForCmd = helperPath.replaceAll("%", "%%").replaceAll("\"", "\"\"");
      const pipeForCmd = pipePath.replaceAll("%", "%%").replaceAll("\"", "\"\"");
      await writeFile(commandPath, `@echo off\r\n"${nodePath}" "${helperForCmd}" "${pipeForCmd}" %*\r\n`, { encoding: "utf8", flag: "wx" });
      command = commandPath;
    } else {
      await chmod(helperPath, 0o700);
    }

    server = createServer((socket) => {
      let request = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => { request += chunk; });
      socket.on("end", () => {
        socket.end(request.toLowerCase().includes("username") ? "x-access-token" : token);
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server?.off("error", onError);
        resolve();
      };
      server?.once("error", onError);
      server?.once("listening", onListening);
      server?.listen(pipePath);
    });
    return { command, server, directory };
  } catch (error) {
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function closeAskpassChannel(channel: AskpassChannel): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!channel.server.listening) {
      resolve();
      return;
    }
    channel.server.close(() => resolve());
  });
  await rm(channel.directory, { recursive: true, force: true });
}

export interface PushWithTokenInput {
  repoPath: string;
  branch: string;
  owner: string;
  repo: string;
  token: string;
}

export interface PushResult {
  ok: true;
}

/** Throws on failure. Never includes the token in a thrown error message. */
export async function pushWithInstallationToken(input: PushWithTokenInput): Promise<PushResult> {
  if (!/^[A-Za-z0-9_.-]+$/.test(input.owner) || !/^[A-Za-z0-9_.-]+$/.test(input.repo)) {
    throw new Error("GitHub repository owner and name contain unsupported characters.");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(input.branch) || input.branch.includes("..") || input.branch.startsWith("/") || input.branch.endsWith("/")) {
    throw new Error("Git branch contains unsupported characters.");
  }
  const remoteUrl = `https://github.com/${input.owner}/${input.repo}.git`;
  const askpass = await openAskpassChannel(input.token);
  try {
    await execFileAsync("git", [
      "-C", input.repoPath,
      "-c", "credential.helper=",
      "push", remoteUrl, `HEAD:refs/heads/${input.branch}`,
    ], {
      env: { ...process.env, GIT_ASKPASS: askpass.command, GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`git push to ${input.owner}/${input.repo}:${input.branch} failed: ${sanitize(error, input.token)}`);
  } finally {
    await closeAskpassChannel(askpass);
  }
  return { ok: true };
}

/** Strips any embedded credential from a caught error's message/output before it can reach a log, feed message, or thrown error. */
function sanitize(error: unknown, token: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replaceAll(token, "***")
    .replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
}
