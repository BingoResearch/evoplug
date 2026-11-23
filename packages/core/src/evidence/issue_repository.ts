/**
 * Issue repository (DD-QP-04a, DD-QP-27, DD-QP-27a).
 *
 * The repository is the only place that mints transitions and judgments. All
 * writes go through `QpJournalCommitPort.commitQpJournal`; the `apply` stage
 * performs the `transition_id` dedupe and `issue_id + expected_version` CAS
 * before the journal frame is written. When no port is injected the same
 * checks run against the in-process projection, which keeps tests honest and
 * makes the missing persistence explicit in `createIssueRepository` options.
 */

import { randomUUID } from "node:crypto";
import type { ErrorEnvelope } from "../errors.js";
import type { Hash } from "../hash.js";
import type { JsonValue } from "../json.js";
import { systemClock, type Clock } from "../clock.js";
import { canonicalJsonText } from "../canonical.js";
import type { Tx } from "../tx.js";
import type { VersionBinding } from "../version-binding.js";
import type { AppendIssueTransitionCommand, AppendIssueTransitionResult, Issue, IssueJudgment, IssueJudgmentDraft, IssueState, IssueSummary, IssueTransitionRecord, IssueWriteRepository } from "./types.js";
import { isTerminalState, transitionTarget } from "./issue_lifecycle.js";
import {
  issueTransitionPayloadHash,
  judgmentHash,
  sortedUniqueRefs,
  toJsonValue,
  transitionContentHash
} from "./hashes.js";
import { qpFailure } from "./errors.js";
import type { QpJournalCommitPort, QpJournalDecision, QpLiveCommitOutcome, QpLiveStage } from "./journal_port.js";

/** Domain error carrying the canonical envelope for a rejected QP command. */
export class QpDomainError extends Error {
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope) {
    super(`${envelope.code}: ${envelope.message_key}`);
    this.name = "QpDomainError";
    this.envelope = envelope;
  }
}

interface IssueRepositoryOptions {
  clock?: Clock;
  commit?: QpJournalCommitPort;
  /**
   * A committed-read source used to hydrate the repository after a crash
   * recovery. The QP reducer writes the typed rows and the object documents
   * in the same transaction, so a restarted process reads the recovered
   * transition, judgment and issue back through this source.
   */
  source?: QpReadSource;
}

/**
 * The minimal committed-read surface the QP repository hydrates from.
 *
 * The shape is deliberately narrow: a read-only `prepare(...).get(...)`
 * handle over the same SQLite database the writer uses.
 */
export interface QpReadSource {
  prepare<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string
  ): { get(params?: Record<string, unknown>): Row | undefined; all?: (params?: Record<string, unknown>) => Row[] };
}

const UNSET_VERSION = 0;

/** True when the binding isolation fields match (watermark excluded). */
export function sameIsolationScope(left: VersionBinding, right: VersionBinding): boolean {
  return (
    left.task_id === right.task_id &&
    left.branch_id === right.branch_id &&
    left.input_epoch === right.input_epoch &&
    left.goal_version === right.goal_version &&
    left.config_version === right.config_version
  );
}

function toIssueSummary(issue: Issue): IssueSummary {
  const summary: IssueSummary = {
    issue_id: issue.issue_id,
    issue_key: issue.issue_key,
    issue_version: issue.issue_version,
    binding: issue.binding,
    type: issue.type,
    state: issue.state,
    subject_key: issue.subject_key,
    requirement_ids: [...issue.requirement_ids],
    artifact_paths: [...issue.artifact_paths],
    artifact_versions: issue.artifact_versions.map((entry) => ({ path: entry.path, version: entry.version })),
    contract_required: issue.contract_required,
    contract_paths: [...issue.contract_paths],
    opened_at_watermark: issue.opened_at_watermark,
    last_observed_watermark: issue.last_observed_watermark
  };
  if (issue.previous_issue_id !== undefined) {
    summary.previous_issue_id = issue.previous_issue_id;
  }
  return summary;
}

function validateTransitionId(transition_id: string): void {
  if (typeof transition_id !== "string") {
    throw new QpDomainError(qpFailure("E_SCHEMA", "issue_transition", { field: "transition_id" }));
  }
  const bytes = new TextEncoder().encode(transition_id);
  if (bytes.length < 1 || bytes.length > 128 || /\s/u.test(transition_id)) {
    throw new QpDomainError(qpFailure("E_SCHEMA", "issue_transition", { field: "transition_id" }));
  }
}

function validateJudgmentAgainstIssue(draft: IssueJudgmentDraft, issue: Issue): void {
  if (draft.judgment_id.length !== 31 || !draft.judgment_id.startsWith("judg:")) {
    throw new QpDomainError(qpFailure("E_SCHEMA", "issue_judgment", { field: "judgment_id" }));
  }
  if (draft.issue_id !== issue.issue_id) {
    throw new QpDomainError(qpFailure("E_SCHEMA", "issue_judgment", { field: "issue_id" }));
  }
  if (draft.issue_key !== issue.issue_key) {
    throw new QpDomainError(qpFailure("E_SCHEMA", "issue_judgment", { field: "issue_key" }));
  }
  if (draft.issue_version !== issue.issue_version) {
    throw new QpDomainError(qpFailure("E_SCHEMA", "issue_judgment", { field: "issue_version" }));
  }
  if (issue.judgment_ref !== draft.judgment_id) {
    throw new QpDomainError(qpFailure("E_SCHEMA", "issue_judgment", { field: "judgment_ref" }));
  }
}

function asJson(value: unknown): JsonValue {
  return toJsonValue(value);
}

/**
 * Creates an issue repository. Without a commit port the projection is kept
 * in memory; with one, every accepted write is committed as exactly one
 * `issue_transition_appended` journal event.
 */
export function createIssueRepository(options: IssueRepositoryOptions = {}): IssueWriteRepository {
  const clock = options.clock ?? systemClock;
  const commitPort = options.commit;
  const issues = new Map<string, Issue>();
  const transitions = new Map<string, IssueTransitionRecord>();
  const judgments = new Map<string, IssueJudgment>();
  const issueByKey = new Map<string, string>();

  /**
   * Reads one recovered object document by `object_id` and `object_type`.
   *
   * The QP reducer writes the typed row and its object document in the same
   * transaction, so the document is the authoritative recovered body.
   */
  function hydrateDocument(object_id: string, object_type: string): JsonValue | null {
    if (options.source === undefined) {
      return null;
    }
    const row = options.source
      .prepare<{ canonical_json: string }>(
        `SELECT canonical_json FROM object_document
          WHERE object_id = :object_id AND object_type = :object_type
          ORDER BY revision DESC LIMIT 1`
      )
      .get({ object_id, object_type });
    if (row === undefined) {
      return null;
    }
    const parsed: unknown = JSON.parse(row.canonical_json);
    return parsed as JsonValue;
  }

  function currentVersion(issue_id: string): number {
    const existing = issues.get(issue_id);
    return existing === undefined ? UNSET_VERSION : existing.issue_version;
  }

  function validateCommand(command: AppendIssueTransitionCommand): {
    existingIssue: Issue | null;
    target: IssueState;
  } {
    validateTransitionId(command.transition_id);
    if (!Number.isSafeInteger(command.expected_version) || command.expected_version < 0) {
      throw new QpDomainError(qpFailure("E_SCHEMA", "issue_transition", { field: "expected_version" }));
    }
    const issue = command.issue;
    if (issue.issue_version !== command.expected_version + 1) {
      throw new QpDomainError(qpFailure("E_SCHEMA", "issue_transition", { field: "issue_version" }));
    }
    if (issue.last_transition_id !== command.transition_id) {
      throw new QpDomainError(qpFailure("E_SCHEMA", "issue_transition", { field: "last_transition_id" }));
    }
    if (issue.issue_id !== command.issue_id) {
      throw new QpDomainError(qpFailure("E_SCHEMA", "issue_transition", { field: "issue_id" }));
    }
    if (issue.state !== command.to_state) {
      throw new QpDomainError(qpFailure("E_SCHEMA", "issue_transition", { field: "to_state" }));
    }
    const target = transitionTarget(command.event, command.from_state, issue.type);
    if (target === null || target !== command.to_state) {
      throw new QpDomainError(
        qpFailure("E_ISSUE_TRANSITION_ILLEGAL", "issue_transition", { event: command.event })
      );
    }
    const existingIssue = issues.get(command.issue_id) ?? null;
    if (command.from_state === "none") {
      if (existingIssue !== null) {
        throw new QpDomainError(
          qpFailure("E_ISSUE_VERSION_CONFLICT", "issue_transition", { issue_id: command.issue_id })
        );
      }
    } else {
      if (existingIssue === null) {
        throw new QpDomainError(qpFailure("E_SCHEMA", "issue_transition", { issue_id: command.issue_id }));
      }
      if (existingIssue.issue_version !== command.expected_version) {
        throw new QpDomainError(
          qpFailure("E_ISSUE_VERSION_CONFLICT", "issue_transition", {
            expected_version: command.expected_version,
            actual_version: existingIssue.issue_version
          })
        );
      }
      if (existingIssue.state !== command.from_state) {
        throw new QpDomainError(
          qpFailure("E_ISSUE_TRANSITION_ILLEGAL", "issue_transition", { from_state: existingIssue.state })
        );
      }
      if (existingIssue.issue_key !== issue.issue_key) {
        throw new QpDomainError(qpFailure("E_SCHEMA", "issue_transition", { field: "issue_key" }));
      }
    }
    return { existingIssue, target };
  }

  /**
   * The frame payload hash of an `issue_transition_appended` event.
   *
   * DD-QP-27a fixes the frame rule as `payload_hash = sha256(JCS(payload))`
   * over the published payload `{transition, judgment}`. The transition inside
   * the payload is the complete `IssueTransitionRecord` minus the two hash
   * fields it cannot contain itself (`payload_hash` and `content_hash`), so
   * the hash is not self-referential. The record's own `payload_hash` field
   * carries this same value, and the reducer recomputes it the same way.
   */

  /**
   * The frame payload of an `issue_transition_appended` event.
   *
   * The published payload is `{transition, judgment}` where the transition is
   * the complete `IssueTransitionRecord` minus the two hash fields it cannot
   * contain itself. The frame's `payload_hash` is `sha256(JCS(payload))` over
   * exactly these bytes, and the record's own `payload_hash` field carries
   * the same value.
   */
  function commandFramePayload(
    base: Omit<IssueTransitionRecord, "payload_hash" | "content_hash">,
    judgment: IssueJudgment | null
  ): JsonValue {
    return asJson({ transition: base, judgment });
  }

  /**
   * The command-derived body of a transition, without the wall clock and
   * without the two hash fields the record cannot contain itself.
   *
   * DD-QP-05: the `transition_id` dedup compares the command body, so a
   * retry of the same command returns the first result even though the audit
   * clock moved on, while the same id with a different body is a collision.
   */
  function commandBody(
    command: AppendIssueTransitionCommand,
    judgment: IssueJudgment | null
  ): JsonValue {
    return asJson({
      transition: {
        schema_version: "rsi.issue_transition/1",
        transition_id: command.transition_id,
        issue_id: command.issue_id,
        expected_version: command.expected_version,
        issue_version: command.issue.issue_version,
        from_state: command.from_state,
        to_state: command.to_state,
        event: command.event,
        evidence_refs: sortedUniqueRefs(command.evidence_refs),
        judgment_ref: judgment === null ? null : judgment.judgment_id,
        task_id: command.issue.binding.task_id,
        branch_id: command.issue.binding.branch_id,
        issue_after: command.issue
      },
      judgment
    });
  }

  /** The judgment a command would produce, without the audit clock. */
  function judgmentFor(command: AppendIssueTransitionCommand): IssueJudgment | null {
    const draft = command.judgment;
    if (draft === undefined) {
      return null;
    }
    return {
      ...draft,
      recorded_at_watermark: command.issue.binding.watermark,
      judgment_hash: judgmentHash(draft)
    };
  }

  /**
   * The command-derived body of an already-stored transition, for the
   * `transition_id` dedup. `recorded_at` and the two hash fields are excluded
   * for the same reason they are excluded from the command body.
   */
  function storedCommandBody(existing: IssueTransitionRecord): JsonValue {
    return asJson({
      transition: {
        schema_version: existing.schema_version,
        transition_id: existing.transition_id,
        issue_id: existing.issue_id,
        expected_version: existing.expected_version,
        issue_version: existing.issue_version,
        from_state: existing.from_state,
        to_state: existing.to_state,
        event: existing.event,
        evidence_refs: existing.evidence_refs,
        judgment_ref: existing.judgment_ref,
        task_id: existing.task_id,
        branch_id: existing.branch_id,
        issue_after: existing.issue_after
      },
      judgment: null
    });
  }

  function buildTransition(command: AppendIssueTransitionCommand, recorded_at: number): {
    transition: IssueTransitionRecord;
    judgment: IssueJudgment | null;
  } {
    const judgmentDraft = command.judgment;
    let judgment: IssueJudgment | null = null;
    if (judgmentDraft !== undefined) {
      validateJudgmentAgainstIssue(judgmentDraft, command.issue);
      judgment = {
        ...judgmentDraft,
        recorded_at_watermark: command.issue.binding.watermark,
        judgment_hash: judgmentHash(judgmentDraft)
      };
    }
    if (command.event === "judge" && judgment === null) {
      throw new QpDomainError(qpFailure("E_SCHEMA", "issue_transition", { field: "judgment" }));
    }
    if (command.event !== "judge" && judgment !== null) {
      throw new QpDomainError(qpFailure("E_SCHEMA", "issue_transition", { field: "judgment" }));
    }
    const base = {
      schema_version: "rsi.issue_transition/1",
      transition_id: command.transition_id,
      issue_id: command.issue_id,
      expected_version: command.expected_version,
      issue_version: command.issue.issue_version,
      from_state: command.from_state,
      to_state: command.to_state,
      event: command.event,
      evidence_refs: sortedUniqueRefs(command.evidence_refs),
      judgment_ref: judgment === null ? null : judgment.judgment_id,
      task_id: command.issue.binding.task_id,
      branch_id: command.issue.binding.branch_id,
      recorded_at,
      issue_after: command.issue
    } satisfies Omit<IssueTransitionRecord, "payload_hash" | "content_hash">;
    const payload_hash = issueTransitionPayloadHash(commandFramePayload(base, judgment));
    const withPayload = { ...base, payload_hash } satisfies Omit<IssueTransitionRecord, "content_hash">;
    const transition: IssueTransitionRecord = {
      ...withPayload,
      content_hash: transitionContentHash(withPayload)
    };
    return { transition, judgment };
  }

  function store(transition: IssueTransitionRecord, judgment: IssueJudgment | null): void {
    transitions.set(transition.transition_id, transition);
    issues.set(transition.issue_after.issue_id, transition.issue_after);
    if (judgment !== null) {
      judgments.set(judgment.judgment_id, judgment);
    }
    if (!isTerminalState(transition.issue_after.state)) {
      issueByKey.set(transition.issue_after.issue_key, transition.issue_after.issue_id);
    }
  }

  /**
   * Records a transition-id collision in the writer-gate transaction so the
   * durable quarantine row survives the enclosing commit. Ports that do not
   * expose a SQL transaction leave quarantine to the storage owner.
   */
  function quarantineCollision(stage: QpLiveStage, payload_hash: Hash): void {
    const tx = stage.tx as Partial<Tx> | null | undefined;
    if (tx === null || tx === undefined || typeof tx.prepare !== "function") {
      return;
    }
    tx.prepare(
      `INSERT INTO quarantine (
         quarantine_id, scope, journal_id, byte_offset, commit_seq,
         reason_code, payload_hash, bytes_ref, discovered_at, resolved_at
       ) VALUES (
         :quarantine_id, 'transition', NULL, NULL, NULL,
         'E_TRANSITION_ID_COLLISION', :payload_hash, NULL, :discovered_at, NULL
       )`
    ).run({
      quarantine_id: randomUUID(),
      payload_hash,
      discovered_at: clock.utcNowMs()
    });
  }

  function applyDecision(
    command: AppendIssueTransitionCommand,
    transition: IssueTransitionRecord,
    judgment: IssueJudgment | null,
    stage?: QpLiveStage
  ): QpJournalDecision {
    const existing = transitions.get(command.transition_id);
    if (existing !== undefined) {
      if (existing.payload_hash !== transition.payload_hash) {
        if (stage !== undefined) {
          quarantineCollision(stage, transition.payload_hash);
          return { kind: "existing", value: asJson({ transition: existing }) };
        }
        throw new QpDomainError(
          qpFailure("E_TRANSITION_ID_COLLISION", "issue_transition", {
            transition_id: command.transition_id
          })
        );
      }
      return { kind: "existing", value: asJson({ transition: existing }) };
    }
    const version = currentVersion(command.issue_id);
    if (command.from_state === "none") {
      if (version !== UNSET_VERSION) {
        throw new QpDomainError(
          qpFailure("E_ISSUE_VERSION_CONFLICT", "issue_transition", { issue_id: command.issue_id })
        );
      }
    } else if (version !== command.expected_version) {
      throw new QpDomainError(
        qpFailure("E_ISSUE_VERSION_CONFLICT", "issue_transition", {
          expected_version: command.expected_version,
          actual_version: version
        })
      );
    }
    store(transition, judgment);
    return { kind: "commit" };
  }

  function appendTransition(command: AppendIssueTransitionCommand): AppendIssueTransitionResult {
    const existing = transitions.get(command.transition_id);
    let colliding = false;
    if (existing !== undefined) {
      if (canonicalJsonText(storedCommandBody(existing)) !== canonicalJsonText(commandBody(command, judgmentFor(command)))) {
        if (commitPort === undefined) {
          throw new QpDomainError(
            qpFailure("E_TRANSITION_ID_COLLISION", "issue_transition", {
              transition_id: command.transition_id
            })
          );
        }
        // Route the collision through the writer gate so the durable
        // quarantine row is written in the same transaction.
        colliding = true;
      } else {
        return {
          transition: existing,
          issue: existing.issue_after,
          judgment:
            existing.judgment_ref === null ? null : (judgments.get(existing.judgment_ref) ?? null),
          deduplicated: true
        };
      }
    }
    if (!colliding) {
      validateCommand(command);
    }
    const recorded_at = clock.utcNowMs();
    const { transition, judgment } = buildTransition(command, recorded_at);
    if (commitPort === undefined) {
      applyDecision(command, transition, judgment);
    } else {
      const eventTransition: IssueTransitionRecord = transition;
      const outcome: QpLiveCommitOutcome = commitPort.commitQpJournal({
        event: {
          schema_version: "rsi.qp_issue_event/1",
          event_type: "issue_transition_appended",
          entity_type: "issue_transition",
          entity_id: command.transition_id,
          payload_hash: eventTransition.payload_hash,
          payload: { transition: eventTransition, judgment }
        },
        apply: (stage): QpJournalDecision => applyDecision(command, eventTransition, judgment, stage)
      });
      if (outcome.commit_state === "not_written") {
        throw new QpDomainError(outcome.error);
      }
      if (outcome.commit_state === "unknown_recovery_required") {
        throw new QpDomainError(
          qpFailure("E_PERSISTENCE_INTEGRITY", "issue_transition", { reason: "unknown_recovery_required" })
        );
      }
      if (outcome.commit_state === "existing") {
        const readBack = transitions.get(command.transition_id);
        if (readBack === undefined) {
          throw new QpDomainError(
            qpFailure("E_PERSISTENCE_INTEGRITY", "issue_transition", { reason: "existing_without_row" })
          );
        }
        if (readBack.payload_hash !== transition.payload_hash) {
          throw new QpDomainError(
            qpFailure("E_TRANSITION_ID_COLLISION", "issue_transition", {
              transition_id: command.transition_id
            })
          );
        }
        return {
          transition: readBack,
          issue: readBack.issue_after,
          judgment: readBack.judgment_ref === null ? null : (judgments.get(readBack.judgment_ref) ?? null),
          deduplicated: true
        };
      }
      // committed: projection was written inside apply; verify read-back hash.
      const readBack = transitions.get(command.transition_id);
      if (readBack === undefined || readBack.content_hash !== transition.content_hash) {
        throw new QpDomainError(
          qpFailure("E_PERSISTENCE_INTEGRITY", "issue_transition", { reason: "readback_mismatch" })
        );
      }
    }
    const stored = transitions.get(command.transition_id);
    if (stored === undefined) {
      throw new QpDomainError(
        qpFailure("E_PERSISTENCE_INTEGRITY", "issue_transition", { reason: "missing_after_commit" })
      );
    }
    return {
      transition: stored,
      issue: stored.issue_after,
      judgment: stored.judgment_ref === null ? null : (judgments.get(stored.judgment_ref) ?? null),
      deduplicated: false
    };
  }

  const repository: IssueWriteRepository = {
    listActive(q): readonly IssueSummary[] {
      const requested = q.states;
      const result: IssueSummary[] = [];
      for (const issue of issues.values()) {
        if (!sameIsolationScope(issue.binding, q.binding)) {
          continue;
        }
        if (requested === undefined) {
          if (issue.state === "stale_goal" || issue.state === "rejected") {
            continue;
          }
        } else if (!requested.includes(issue.state)) {
          continue;
        }
        result.push(toIssueSummary(issue));
      }
      return result;
    },
    getIssue(issue_id: string): Issue | null {
      const cached = issues.get(issue_id);
      if (cached !== undefined) {
        return cached;
      }
      const hydrated = hydrateDocument(issue_id, "issue");
      return hydrated === null ? null : (hydrated as unknown as Issue);
    },
    getIssueJudgment(judgment_id: string): IssueJudgment | null {
      const judgment = judgments.get(judgment_id);
      if (judgment !== undefined) {
        if (judgment.accepted !== true) {
          return null;
        }
        const recomputed = judgmentHash(judgment);
        return recomputed === judgment.judgment_hash ? judgment : null;
      }
      const hydrated = hydrateDocument(judgment_id, "issue_judgment");
      if (hydrated === null) {
        return null;
      }
      const record = hydrated as unknown as IssueJudgment;
      if (record.accepted !== true) {
        return null;
      }
      return judgmentHash(record) === record.judgment_hash ? record : null;
    },
    getTransition(transition_id: string): IssueTransitionRecord | null {
      const cached = transitions.get(transition_id);
      if (cached !== undefined) {
        return cached;
      }
      const hydrated = hydrateDocument(transition_id, "issue_transition");
      return hydrated === null ? null : (hydrated as unknown as IssueTransitionRecord);
    },
    appendTransition
  };
  return repository;
}

