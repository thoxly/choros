/**
 * src/http/externalWorker.ts
 *
 * Registers the four external-worker HTTP endpoints onto a Router instance.
 * Zero external runtime dependencies — imports only from node: stdlib and
 * internal project modules.
 */
import { HttpError, mapDomainError, readJsonBody, type Router } from "./router.js";
import { JobStore } from "../core/jobStore.js";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isFiniteIntegerGte(v: unknown, min: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= min;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerExternalWorkerRoutes(router: Router, store: JobStore): void {
  // POST /jobs — enqueue a new job
  router.register("POST", "/jobs", async (req, res) => {
    const body = await readJsonBody(req);

    if (!isPlainObject(body)) {
      throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
    }

    const { topic, variables, retries } = body as {
      topic: unknown;
      variables: unknown;
      retries: unknown;
    };

    if (!isNonEmptyString(topic)) {
      if (typeof topic === "undefined" || topic === null) {
        throw new HttpError(400, "VALIDATION", "topic is required and must be a non-empty string");
      }
      if (typeof topic !== "string") {
        throw new HttpError(400, "VALIDATION", "topic must be a string");
      }
      // topic is a string but empty
      throw new HttpError(400, "VALIDATION", "topic must not be an empty string");
    }

    if (variables !== undefined && variables !== null) {
      if (!isPlainObject(variables)) {
        throw new HttpError(400, "VALIDATION", "variables must be a plain JSON object if provided");
      }
    }

    if (retries !== undefined && retries !== null) {
      if (!isFiniteIntegerGte(retries, 0)) {
        throw new HttpError(
          400,
          "VALIDATION",
          "retries must be a finite integer >= 0 if provided"
        );
      }
    }

    const job = store.enqueue(
      topic,
      (variables as Record<string, unknown>) ?? {},
      (retries as number) ?? 0
    );

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(job));
  });

  // POST /external-task/fetch-and-lock — acquire up to maxJobs locked jobs
  router.register("POST", "/external-task/fetch-and-lock", async (req, res) => {
    const body = await readJsonBody(req);

    if (!isPlainObject(body)) {
      throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
    }

    const { workerId, topics, maxJobs, lockDurationMs } = body as {
      workerId: unknown;
      topics: unknown;
      maxJobs: unknown;
      lockDurationMs: unknown;
    };

    if (!isNonEmptyString(workerId)) {
      throw new HttpError(400, "VALIDATION", "workerId is required and must be a non-empty string");
    }

    if (!Array.isArray(topics)) {
      throw new HttpError(400, "VALIDATION", "topics is required and must be an array");
    }

    for (const t of topics) {
      if (typeof t !== "string") {
        throw new HttpError(400, "VALIDATION", "each element in topics must be a string");
      }
    }

    if (!isFiniteIntegerGte(maxJobs, 1)) {
      throw new HttpError(400, "VALIDATION", "maxJobs is required and must be a finite integer >= 1");
    }

    if (!isFiniteIntegerGte(lockDurationMs, 1)) {
      throw new HttpError(
        400,
        "VALIDATION",
        "lockDurationMs is required and must be a finite integer >= 1"
      );
    }

    const jobs = store.fetchAndLock(
      workerId,
      topics as string[],
      maxJobs as number,
      lockDurationMs as number
    );

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jobs }));
  });

  // POST /external-task/:id/complete — mark a job as completed
  router.register("POST", "/external-task/:id/complete", async (req, res, params) => {
    const body = await readJsonBody(req);

    if (!isPlainObject(body)) {
      throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
    }

    const { workerId } = body as { workerId: unknown };

    if (!isNonEmptyString(workerId)) {
      throw new HttpError(400, "VALIDATION", "workerId is required and must be a non-empty string");
    }

    const jobId = params["id"] as string;
    const result = store.complete(workerId, jobId);

    if (!result.ok) {
      throw mapDomainError(result.code);
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });

  // POST /external-task/:id/fail — report a job failure and optionally schedule retry
  router.register("POST", "/external-task/:id/fail", async (req, res, params) => {
    const body = await readJsonBody(req);

    if (!isPlainObject(body)) {
      throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
    }

    const { workerId, retries, retryTimeoutMs } = body as {
      workerId: unknown;
      retries: unknown;
      retryTimeoutMs: unknown;
    };

    if (!isNonEmptyString(workerId)) {
      throw new HttpError(400, "VALIDATION", "workerId is required and must be a non-empty string");
    }

    if (!isFiniteIntegerGte(retries, 0)) {
      throw new HttpError(400, "VALIDATION", "retries is required and must be a finite integer >= 0");
    }

    if (!isFiniteIntegerGte(retryTimeoutMs, 0)) {
      throw new HttpError(
        400,
        "VALIDATION",
        "retryTimeoutMs is required and must be a finite integer >= 0"
      );
    }

    const jobId = params["id"] as string;
    const result = store.fail(
      workerId,
      jobId,
      retries as number,
      retryTimeoutMs as number
    );

    if (!result.ok) {
      throw mapDomainError(result.code);
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
}
