/**
 * HOST journal event shape (DD-FND-070).
 *
 * A host event enters the shared journal as a `HostJournalEvent`: the
 * committed `EventEnvelope` without the two fields the journal assigns
 * itself. `commit_seq` and `watermark` are frame-level facts; the envelope
 * that a host event carries is the pre-commit image.
 *
 * The type is type-only: it narrows `EventEnvelope` and adds no field.
 */

import type { EventEnvelope } from "../generated/types/event-envelope.js";

export type HostJournalEvent = Omit<EventEnvelope, "commit_seq" | "watermark">;
