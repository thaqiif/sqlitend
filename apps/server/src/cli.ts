// ---------------------------------------------------------------------------
// sqlitend operator CLI — runs on the server against the metadata DB (safe
// while the control plane is running: WAL + short transactions).
//
//   sqlitend set-password      set/replace the admin password (ends all sessions)
//   sqlitend enable-totp       turn on authenticator codes (ends all sessions)
//   sqlitend disable-totp      turn them off (ends all sessions)
//   sqlitend revoke-sessions   log out everywhere
//   sqlitend audit [N]         print the last N audit entries (default 30)
// ---------------------------------------------------------------------------

import path from "node:path";
import { createInterface } from "node:readline";
import { loadConfig } from "./config.ts";
import { openMetadata } from "./db/metadata.ts";
import { MIN_PASSWORD_LENGTH } from "./auth/session.ts";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./auth/totp.ts";

export const CLI_COMMANDS = ["set-password", "enable-totp", "disable-totp", "revoke-sessions", "audit"] as const;

/** Read one line; with a TTY the input is not echoed. Piped stdin works too. */
async function prompt(question: string, hidden = false): Promise<string> {
  const stdin = process.stdin;
  if (hidden && stdin.isTTY) {
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    let value = "";
    return new Promise((resolve, reject) => {
      const onData = (buf: Buffer) => {
        for (const ch of buf.toString("utf8")) {
          if (ch === "\r" || ch === "\n") {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.off("data", onData);
            process.stdout.write("\n");
            return resolve(value);
          }
          if (ch === "\u0003") {
            stdin.setRawMode(false);
            return reject(new Error("cancelled"));
          }
          if (ch === "\u007f") value = value.slice(0, -1);
          else value += ch;
        }
      };
      stdin.on("data", onData);
    });
  }
  process.stdout.write(question);
  const line = await nextLine();
  if (line === null) throw new Error("no input");
  return line;
}

// One reader for the whole run: a readline per prompt would buffer and drop
// the lines meant for later prompts when stdin is piped.
let lineQueue: string[] | null = null;
let lineWaiters: ((l: string | null) => void)[] = [];
let stdinClosed = false;
function nextLine(): Promise<string | null> {
  if (!lineQueue) {
    lineQueue = [];
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (l) => {
      const w = lineWaiters.shift();
      if (w) w(l);
      else lineQueue!.push(l);
    });
    rl.on("close", () => {
      stdinClosed = true;
      for (const w of lineWaiters) w(null);
      lineWaiters = [];
    });
  }
  if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift()!);
  if (stdinClosed) return Promise.resolve(null);
  return new Promise((resolve) => lineWaiters.push(resolve));
}

export async function runCli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const config = loadConfig();
  const meta = openMetadata(path.join(config.dataRoot, "metadata.sqlite"));
  const { auth } = meta;
  const log = (action: string, detail: string | null = null) =>
    auth.audit({ actor: "cli", ip: null, action, target: null, outcome: "ok", detail });

  try {
    switch (cmd) {
      case "set-password": {
        const pw = await prompt("New admin password: ", true);
        if (pw.length < MIN_PASSWORD_LENGTH) {
          console.error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
          return 1;
        }
        const again = await prompt("Repeat: ", true);
        if (again !== pw) {
          console.error("passwords do not match");
          return 1;
        }
        auth.setPassword(await Bun.password.hash(pw), Date.now());
        log("auth.set_password");
        console.log("password set; all sessions ended");
        return 0;
      }
      case "enable-totp": {
        if (!auth.getAdmin()) {
          console.error("set a password first: sqlitend set-password");
          return 1;
        }
        const secret = generateTotpSecret();
        console.log("Add this to your authenticator app:\n");
        console.log(`  secret: ${secret}`);
        console.log(`  uri:    ${otpauthUri(secret)}\n`);
        const code = (await prompt("Enter the 6-digit code it shows: ")).trim();
        if (!verifyTotp(secret, code, Date.now())) {
          console.error("code did not match; TOTP not enabled");
          return 1;
        }
        auth.setTotpSecret(secret);
        log("auth.enable_totp");
        console.log("TOTP enabled; all sessions ended");
        return 0;
      }
      case "disable-totp":
        auth.setTotpSecret(null);
        log("auth.disable_totp");
        console.log("TOTP disabled; all sessions ended");
        return 0;
      case "revoke-sessions": {
        const n = auth.deleteAllSessions();
        log("auth.revoke_sessions", `${n} session(s)`);
        console.log(`ended ${n} session(s)`);
        return 0;
      }
      case "audit": {
        // Route params are attacker-influenced; never let them drive the terminal.
        const clean = (v: string) => v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
        const n = Math.min(500, Math.max(1, Number(rest[0] ?? 30) || 30));
        for (const r of auth.listAudit(n).reverse()) {
          console.log(
            clean(
              `${new Date(r.at).toISOString()}  ${r.outcome.padEnd(6)} ${r.actor.padEnd(9)} ${(r.ip ?? "-").padEnd(15)} ${r.action}` +
                `${r.target ? ` ${r.target}` : ""}${r.detail ? `  (${r.detail})` : ""}`,
            ),
          );
        }
        return 0;
      }
      default:
        console.error(`unknown command "${cmd}". commands: ${CLI_COMMANDS.join(", ")}`);
        return 2;
    }
  } finally {
    meta.db.close();
  }
}

if (import.meta.main) process.exit(await runCli(process.argv.slice(2)));
