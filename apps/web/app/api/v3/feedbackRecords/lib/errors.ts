import "server-only";

/**
 * Feedback-record wording for the two Hub conditions this surface has to explain. The generic Hub→problem
 * mapping lives in `@/app/api/v3/lib/hub-errors`; only the domain-specific messages belong here, because
 * the same upstream status means different things to different features.
 */

/**
 * Semantic search and similarity need embeddings, which are optional in the Hub. Our own static message,
 * not the upstream body: it names the setting to change, on both processes that need it.
 */
export const EMBEDDINGS_UNAVAILABLE_DETAIL =
  "Semantic search is not available: the feedback service has no embedding model configured. A self-hosting administrator can enable it by setting EMBEDDING_PROVIDER and EMBEDDING_MODEL on both the Hub API and the Hub worker.";

/**
 * A record that exists and belongs to the caller, yet has no embedding — the only thing a Hub 404 can
 * mean once ownership is proven. Reported as 409, not 404, because the record *is* there; the message
 * distinguishes the two causes, because only one of them is worth retrying (a fresh record is still being
 * embedded, whereas a record with no text has no embedding to wait for).
 */
export const EMBEDDING_PENDING_DETAIL =
  "This feedback record has no embedding, so similar records cannot be found. If it was just created, embeddings are generated in the background — retry in a moment. If it has no text, or its text was cleared by an update, it has no embedding at all and retrying will not help.";
