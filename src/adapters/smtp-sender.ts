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
