/**
 * Machine-local commit signing for the Agent Bridge (plan §11.2/§11.3). The
 * private key never leaves this process — it is generated on disk here,
 * used by the local `git` binary via `gpg.format=ssh`, and only the PUBLIC
 * key/fingerprint is ever sent to the server (mission-application-service.ts
 * has no signing-key write path of its own; registration is the caller's
 * job via whatever endpoint stores participant identities).
 *
 * Verified against real `git`/`ssh-keygen` locally: SSH-format signing
 * produces a genuine, git-verifiable Ed25519 signature
 * (`git log --show-signature` reports "Good git signature") once
 * gpg.ssh.allowedSignersFile is configured — see
 * scripts/git-signer.test.ts, which exercises the real binaries rather than
 * mocking them.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SigningIdentity {
  privateKeyPath: string;
  publicKey: string;
  fingerprint: string;
}

/** Idempotent: reuses an existing keypair at keyPath rather than rotating it on every call. */
export function ensureSigningIdentity(keyPath: string, comment: string): SigningIdentity {
  if (!existsSync(keyPath)) {
    mkdirSync(dirname(keyPath), { recursive: true });
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", comment], { stdio: "pipe" });
  }
  // Read the public key through Node instead of spawning Unix `cat`; the
  // bridge is a supported Windows runtime as well as a POSIX one.
  const publicKey = readFileSync(`${keyPath}.pub`, "utf8").trim();
  const fingerprint = execFileSync("ssh-keygen", ["-lf", `${keyPath}.pub`], { encoding: "utf8" }).trim();
  return { privateKeyPath: keyPath, publicKey, fingerprint };
}

/** Configures a worktree to sign commits with this identity and (optionally) verify against a known-good allowed-signers list. */
export function configureRepositoryForSigning(repoPath: string, identity: SigningIdentity, allowedSignersPath?: string): void {
  execFileSync("git", ["-C", repoPath, "config", "gpg.format", "ssh"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoPath, "config", "user.signingkey", `${identity.privateKeyPath}.pub`], { stdio: "pipe" });
  if (allowedSignersPath) execFileSync("git", ["-C", repoPath, "config", "gpg.ssh.allowedSignersFile", allowedSignersPath], { stdio: "pipe" });
}

export interface SignedCommitResult {
  commitSha: string;
  /** True only when git itself reports a verifiable signature — never assumed true just because `-S` was passed. */
  signatureVerified: boolean;
}

/** Commits whatever is currently staged in repoPath, signed with the configured identity. Caller stages files first — this never runs `git add`. */
export function signAndCommit(repoPath: string, input: { authorName: string; authorEmail: string; message: string }): SignedCommitResult {
  execFileSync("git", ["-C", repoPath, "-c", `user.name=${input.authorName}`, "-c", `user.email=${input.authorEmail}`, "commit", "-S", "-m", input.message], { stdio: "pipe" });
  const commitSha = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  let signatureVerified = false;
  try {
    execFileSync("git", ["-C", repoPath, "verify-commit", commitSha], { stdio: "pipe" });
    signatureVerified = true;
  } catch {
    // No allowedSignersFile configured, or verification genuinely failed —
    // either way this is a fact to report, never assumed true.
  }
  return { commitSha, signatureVerified };
}
