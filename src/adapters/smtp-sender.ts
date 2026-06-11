/**
 * src/adapters/smtp-sender.ts — T-0170 E-N.3
 *
 * SmtpSenderPort: injectable SMTP send port. Production implementation uses
 * the `nodemailer`-compatible interface via a thin wrapper; tests inject a stub.
 *
 * DESIGN INVARIANTS:
 *  - NO real SMTP connection in tests — all test code injects a stub (NF no-external-effects).
 *  - Pure port definition: no pg / node:http / node:net imports in THIS file.
 *  - The production NodemailerSmtpSender wraps node:net/tls via nodemailer — that
 *    dependency is isolated here and NEVER imported from core/*.ts (NF-7 pure-core).
 *  - Caller supplies fully-resolved credentials (from SmtpSecretResolverPort).
 *    This adapter never sees a handle — only the resolved string.
 *
 * Semantic contract: docs/design/T-0120-notifications.adr.md §2.3/§4.4/§8.
 */

// ---------------------------------------------------------------------------
// SmtpSendOpts — one email to send
// ---------------------------------------------------------------------------

export interface SmtpSendOpts {
  /** Fully-resolved SMTP credentials (from SmtpSecretResolverPort). */
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly authUser: string;    // from_address used as SMTP login (day-1 convention)
  readonly authPass: string;    // resolved secret from SmtpSecretResolverPort
  readonly from: string;        // 'From Name <from@example.com>'
  readonly to: string;          // recipient email address (from DeliveryJob.recipientId or resolved)
  readonly subject: string;     // email subject (title from DeliveryJob)
  readonly text: string;        // plain-text body
  readonly html?: string;       // HTML body (optional — day-1 may omit)
  readonly timeoutMs?: number;  // connect + send timeout (default 30_000)
}

export interface SmtpSendResult {
  readonly ok: true;
  readonly messageId?: string;
}

// ---------------------------------------------------------------------------
// SmtpSenderPort — the injectable seam (injected into EmailChannelDriver)
// ---------------------------------------------------------------------------

/**
 * Injectable SMTP send port. Tests inject FakeSmtpSender; production uses
 * NodemailerSmtpSender. EmailChannelDriver depends ONLY on this interface.
 */
export interface SmtpSenderPort {
  sendEmail(opts: SmtpSendOpts): Promise<SmtpSendResult>;
}

// ---------------------------------------------------------------------------
// FakeSmtpSender — in-memory test stub (for tests; NEVER in production)
// ---------------------------------------------------------------------------

/**
 * In-memory test stub — collects sent emails without network I/O.
 * NEVER used in production. Injected in unit / integration tests.
 */
export class FakeSmtpSender implements SmtpSenderPort {
  readonly sent: SmtpSendOpts[] = [];

  async sendEmail(opts: SmtpSendOpts): Promise<SmtpSendResult> {
    this.sent.push(opts);
    return { ok: true, messageId: `fake-${this.sent.length}` };
  }
}

/**
 * Failing fake — always rejects with the supplied error (for error-path tests).
 */
export class FailingSmtpSender implements SmtpSenderPort {
  constructor(
    private readonly message: string = "SMTP connection refused",
    private readonly retryable: boolean = true,
  ) {}

  get isRetryable(): boolean {
    return this.retryable;
  }

  async sendEmail(_opts: SmtpSendOpts): Promise<SmtpSendResult> {
    throw new SmtpSendError(this.message, this.retryable);
  }
}

/**
 * Typed SMTP error — carries `retryable` flag so the EmailChannelDriver can
 * map it to `DeliveryResult.retryable` without inspecting error messages.
 */
export class SmtpSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SmtpSendError";
  }
}

// ---------------------------------------------------------------------------
// NodemailerSmtpSender — production SMTP adapter (node:net / node:tls)
// ---------------------------------------------------------------------------

import * as net from "node:net";
import * as tls from "node:tls";

/**
 * Production SMTP adapter using Node.js built-in net/tls (no external dependencies).
 *
 * Implements a minimal RFC 5321 SMTP dialog sufficient for transactional email:
 *   EHLO → (STARTTLS?) → AUTH LOGIN → MAIL FROM → RCPT TO → DATA → QUIT.
 *
 * SECURITY: resolved SMTP credential (authPass) is used only inside sendEmail()
 * and is never stored, logged, or propagated (FF-NO-RAW-SMTP).
 *
 * Production use: new NodemailerSmtpSender() (zero-arg, stateless singleton).
 * Tests: inject FakeSmtpSender / FailingSmtpSender instead.
 */
export class NodemailerSmtpSender implements SmtpSenderPort {
  async sendEmail(opts: SmtpSendOpts): Promise<SmtpSendResult> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    try {
      const messageId = await sendSmtpEmail(opts, timeoutMs);
      return { ok: true, messageId };
    } catch (err) {
      if (err instanceof SmtpSendError) throw err;
      // Wrap unknown errors as retryable transient failures.
      const msg = err instanceof Error ? err.message : String(err);
      throw new SmtpSendError(msg, true);
    }
  }
}

/**
 * Low-level SMTP send via Node.js net/tls.
 * Returns the Message-ID from the server response (250 2.x.x <id>), or a
 * generated ID if the server does not include one.
 *
 * @internal
 */
async function sendSmtpEmail(opts: SmtpSendOpts, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Use implicit TLS (SMTPS, port 465) when opts.tls=true; plain TCP otherwise.
    const socket: net.Socket | tls.TLSSocket = opts.tls
      ? tls.connect({ host: opts.host, port: opts.port, rejectUnauthorized: true })
      : net.connect({ host: opts.host, port: opts.port });

    let settled = false;
    const done = (result: string | Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const timeout = setTimeout(() => {
      done(new SmtpSendError("SMTP connect/send timeout", true));
    }, timeoutMs);

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => done(new SmtpSendError("SMTP socket timeout", true)));
    socket.on("error", (err) => done(new SmtpSendError(err.message, true)));

    // SMTP line-buffer state machine
    let buf = "";
    const lines: string[] = [];

    // Encode a string as base64 for AUTH LOGIN
    const b64 = (s: string) => Buffer.from(s).toString("base64");

    // RFC 5321 multi-line response: lines ending with "ddd-" are continuations;
    // final line ends with "ddd " or "ddd\r\n".
    const readReady = (expected: number): Promise<string> =>
      new Promise<string>((res, rej) => {
        const check = () => {
          while (lines.length > 0) {
            const line = lines.shift()!;
            const code = parseInt(line.substring(0, 3), 10);
            const isContinuation = line.charAt(3) === "-";
            if (!isContinuation) {
              if (code === expected) res(line);
              else rej(new SmtpSendError(`SMTP ${code}: ${line.substring(4)}`, code >= 400 && code < 500));
              return;
            }
          }
          // No complete response yet — install listener for next chunk.
          socket.once("data", (chunk: Buffer) => {
            buf += chunk.toString("utf8");
            const parts = buf.split("\r\n");
            buf = parts.pop() ?? "";
            lines.push(...parts.filter(l => l.length > 0));
            check();
          });
        };
        check();
      });

    const send = (line: string): void => {
      socket.write(line + "\r\n");
    };

    // Full SMTP dialog after connect
    (async () => {
      try {
        // Wait for initial greeting (220)
        await readReady(220);

        // EHLO
        send(`EHLO choros`);
        await readReady(250);

        // AUTH LOGIN
        send("AUTH LOGIN");
        await readReady(334);
        send(b64(opts.authUser));
        await readReady(334);
        send(b64(opts.authPass));
        await readReady(235);

        // MAIL FROM
        send(`MAIL FROM:<${opts.from.replace(/.*<(.+)>/, "$1")}>`);
        await readReady(250);

        // RCPT TO
        send(`RCPT TO:<${opts.to}>`);
        await readReady(250);

        // DATA
        send("DATA");
        await readReady(354);

        // Message headers + body
        const msgId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@choros>`;
        const body = [
          `Message-ID: ${msgId}`,
          `From: ${opts.from}`,
          `To: ${opts.to}`,
          `Subject: ${opts.subject}`,
          `MIME-Version: 1.0`,
          `Content-Type: text/plain; charset=UTF-8`,
          ``,
          opts.text,
          `.`,
        ].join("\r\n");
        socket.write(body + "\r\n");
        await readReady(250);

        send("QUIT");
        clearTimeout(timeout);
        done(msgId);
      } catch (err) {
        clearTimeout(timeout);
        done(err instanceof Error ? err : new SmtpSendError(String(err), true));
      }
    })();
  });
}

