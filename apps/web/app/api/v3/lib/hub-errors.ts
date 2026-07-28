import "server-only";
import type { z } from "zod";
import type { logger } from "@formbricks/logger";
import { DatabaseError, ResourceNotFoundError } from "@formbricks/types/errors";
import {
  type InvalidParam,
  problemBadGateway,
  problemBadRequest,
  problemConflict,
  problemForbidden,
  problemInternalError,
  problemPayloadTooLarge,
  problemServiceUnavailable,
  problemTooManyRequests,
  problemUnprocessableContent,
} from "@/app/api/v3/lib/response";
import type { HubError } from "@/modules/hub/utils";

/**
 * Hub failures and unexpected throws → controlled v3 problem responses.
 *
 * Shared by every v3 surface that talks to the Formbricks Hub, so the rules with the disclosure risk —
 * which upstream statuses may echo their detail, and how much of it — live in exactly one place and are
 * tested on their own. Domain-specific wording (what a 503 means for *your* feature) belongs to the caller;
 * see `serviceUnavailableDetail` below.
 */

// Bounds on what a Hub 4xx may contribute to our response body (see `hubErrorToProblemResponse`).
const MAX_RELAYED_INVALID_PARAMS = 20;
const MAX_RELAYED_DETAIL_LENGTH = 512;

/**
 * Fallback when a caller does not say what a Hub 503 means for its feature. Deliberately vague: a 503 is
 * always "some optional Hub subsystem this endpoint needs is not configured", and only the caller knows
 * which one — so a caller that can 503 should pass `serviceUnavailableDetail` rather than ship this.
 */
const GENERIC_SERVICE_UNAVAILABLE_DETAIL =
  "This feature depends on a part of the feedback service that is not configured on this deployment.";

/**
 * Hub statuses whose detail describes the *caller's own* request, and may therefore be echoed: a rejected
 * field value, a duplicate submission, an oversized record.
 *
 * Deliberately not "any 4xx". A Hub 401/403 means *our* Hub credentials were refused and a 404 can reveal
 * upstream addressing — neither is the caller's business, and both would be describing our infrastructure
 * rather than their request.
 */
const RELAYABLE_HUB_STATUSES = new Set([400, 409, 413, 422]);

/**
 * The one place that decides what a Hub failure may say to a caller.
 *
 * The Hub owns content rules we deliberately don't duplicate (NULL bytes, its own length limits), so for
 * the statuses above its message is relayed — bounded — because without it an agent cannot correct its own
 * request. Everything else is replaced by a fixed string. Used both for whole-request problem responses and
 * for the per-record failures of a batch write, so neither can drift into leaking more than the other.
 */
export function relayableHubDetail(error: HubError | null, fallback: string): string {
  if (!error?.problemDetail || !RELAYABLE_HUB_STATUSES.has(error.status)) {
    return fallback;
  }
  return error.problemDetail.slice(0, MAX_RELAYED_DETAIL_LENGTH);
}

/**
 * Map a Hub service error to a controlled v3 problem response.
 *
 * A Hub 400/422 describes the *caller's own* input, so its field-level detail is relayed: the Hub owns
 * the content rules we deliberately don't duplicate here (NULL bytes, its own length limits), and
 * without them an agent can't correct its request. Everything else —
 * unconfigured/unreachable Hub, our own Hub credentials being rejected, upstream 5xx — collapses to a
 * generic 502 and is only ever logged, never echoed.
 */
export function hubErrorToProblemResponse(
  error: HubError | null,
  requestId: string,
  instance: string,
  options?: {
    /**
     * What a Hub 503 means for this feature. Required in practice for any surface that can actually get
     * one: the Hub returns 503 for several unrelated unconfigured subsystems, so a shared message would be
     * wrong somewhere. Callers that can never 503 may omit it.
     */
    serviceUnavailableDetail?: string;
  }
): Response {
  const status = error?.status ?? 0;
  if (status === 429) {
    return problemTooManyRequests(requestId, "The feedback service is rate limiting requests.");
  }

  // A duplicate (submission_id, field_id) or an in-progress tenant purge — the caller's request, not an
  // outage, and retryable in the purge case. Reported as 409 so an agent doesn't retry-loop on a 502.
  if (status === 409) {
    return problemConflict(
      requestId,
      relayableHubDetail(error, "The feedback service reported a conflict."),
      instance
    );
  }

  // The Hub's body cap is lower than ours, so this is reachable with a large (but locally valid) payload.
  if (status === 413) {
    return problemPayloadTooLarge(
      requestId,
      relayableHubDetail(error, "The feedback record is too large."),
      instance
    );
  }

  // Embeddings are optional in the Hub, and the search endpoints are the only ones that need them. A
  // deployment-level "not enabled", not an outage — so it must not collapse into the generic 502 below,
  // which would read as "retry later" for something no retry can fix.
  if (status === 503) {
    return problemServiceUnavailable(
      requestId,
      options?.serviceUnavailableDetail ?? GENERIC_SERVICE_UNAVAILABLE_DETAIL,
      instance
    );
  }

  if (status === 400 || status === 422) {
    // Only name/reason cross over: the Hub's `code` vocabulary is its own, not the v3 InvalidParamCode set.
    // Bounded on both axes — the Hub is a remote service, so we don't let it size our response body.
    const invalidParams: InvalidParam[] | undefined = error?.invalidParams
      ?.slice(0, MAX_RELAYED_INVALID_PARAMS)
      .map(({ name, reason }) => ({
        name: name.slice(0, MAX_RELAYED_DETAIL_LENGTH),
        reason: reason.slice(0, MAX_RELAYED_DETAIL_LENGTH),
      }));
    const detail = relayableHubDetail(error, "The feedback service rejected the request.");

    return status === 400
      ? problemBadRequest(requestId, detail, { instance, invalid_params: invalidParams })
      : problemUnprocessableContent(requestId, detail, { instance, invalid_params: invalidParams });
  }

  return problemBadGateway(requestId, "The feedback service is unavailable.", instance);
}

export function handleUnexpectedError(
  err: unknown,
  log: ReturnType<typeof logger.withContext>,
  requestId: string,
  instance: string
): Response {
  if (err instanceof ResourceNotFoundError) {
    log.warn({ statusCode: 403, errorCode: err.name }, "Resource not found");
    return problemForbidden(requestId, "You are not authorized to access this resource", instance);
  }
  if (err instanceof DatabaseError) {
    log.error({ error: err, statusCode: 500 }, "Database error");
    return problemInternalError(requestId, "An unexpected error occurred.", instance);
  }
  log.error({ error: err, statusCode: 500 }, "Unexpected error");
  return problemInternalError(requestId, "An unexpected error occurred.", instance);
}

export const toInvalidParams = (error: z.ZodError): InvalidParam[] =>
  error.issues.map((issue) => ({ name: issue.path.join("."), reason: issue.message }));
