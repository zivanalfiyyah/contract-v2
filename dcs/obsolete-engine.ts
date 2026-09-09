import type { Pool } from "pg";
import { withTransaction } from "./db-tx.js";
import { assertTransition, type VersionStatus } from "./state-machine.js";

export interface PromoteResult {
  documentId: string;
  newEffectiveVersionId: string;
  supersededVersionId: string | null;
  effectiveAt: string;
}

// DRY: audit + notification are the platform's centralized services, injected —
// not re-implemented here. Both optional so the engine is unit-testable alone.
export interface PlatformServices {
  audit?: { log(e: { tenantId: string; actorId: string; action: string; detail: Record<string, unknown> }): void | Promise<void> };
  notify?: { onVersionEffective(versionId: string): void | Promise<void> };
}

/**
 * Promotes an `approved` version to `effective` and, in the SAME transaction,
 * flips the currently-effective version to `superseded`.
 *
 * Safe under concurrency because:
 *   1. SELECT ... FOR UPDATE on the document row serializes promotions for it.
 *   2. The partial unique index uq_dcs_one_effective_per_doc is the backstop —
 *      Postgres physically refuses a second live master. Demote-then-promote
 *      ordering keeps that index satisfied mid-transaction.
 *   3. now() is the transaction timestamp, so superseded_at and effective_at are
 *      the identical instant — the "exact millisecond" cutover, no clock skew.
 */
export async function promoteVersionToEffective(
  pool: Pool,
  params: {
    tenantId: string; documentId: string; targetVersionId: string; actorId: string;
    // Tanggal berlaku eksplisit (ISO) untuk rilis TERJADWAL — versi diberlakukan
    // "sejak tanggal X" walau proses aktivasi (cron) berjalan beberapa jam
    // setelahnya. Kosong = berlaku sekarang (now()), perilaku rilis manual.
    // superseded_at versi lama tetap now() (saat cutover sesungguhnya).
    effectiveAt?: string | null;
  },
  services: PlatformServices = {},
): Promise<PromoteResult> {
  const { tenantId, documentId, targetVersionId, actorId, effectiveAt } = params;

  const result = await withTransaction(pool, async (client) => {
    const doc = await client.query(
      `SELECT id FROM dcs_documents WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [documentId, tenantId],
    );
    if (doc.rowCount === 0) throw new Error(`Document ${documentId} not found`);

    const target = await client.query<{ status: VersionStatus }>(
      `SELECT status FROM dcs_document_versions
        WHERE id = $1 AND document_id = $2 AND tenant_id = $3`,
      [targetVersionId, documentId, tenantId],
    );
    if (target.rowCount === 0) throw new Error(`Version ${targetVersionId} not found for this document`);
    assertTransition(target.rows[0].status, "effective"); // rejects unless 'approved'

    const demoted = await client.query<{ id: string }>(
      `UPDATE dcs_document_versions
          SET status = 'superseded', superseded_at = now(), updated_at = now()
        WHERE document_id = $1 AND tenant_id = $2 AND status = 'effective'
        RETURNING id`,
      [documentId, tenantId],
    );
    const supersededVersionId = demoted.rows[0]?.id ?? null;

    const promoted = await client.query<{ effective_at: string }>(
      `UPDATE dcs_document_versions
          SET status = 'effective', effective_at = COALESCE($3::timestamptz, now()),
              metadata = metadata - 'scheduledEffectiveAt', updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND status = 'approved'
        RETURNING effective_at`,
      [targetVersionId, tenantId, effectiveAt ?? null],
    );
    if (promoted.rowCount === 0) {
      throw new Error(`Version ${targetVersionId} was no longer 'approved' at promotion time`);
    }

    await client.query(
      `UPDATE dcs_documents SET current_version_id = $1, updated_at = now()
        WHERE id = $2 AND tenant_id = $3`,
      [targetVersionId, documentId, tenantId],
    );

    await services.audit?.log({
      tenantId, actorId, action: "DCS_VERSION_EFFECTIVE",
      detail: { documentId, newEffectiveVersionId: targetVersionId, supersededVersionId },
    });

    return {
      documentId,
      newEffectiveVersionId: targetVersionId,
      supersededVersionId,
      effectiveAt: promoted.rows[0].effective_at,
    };
  });

  // Fire notifications AFTER commit — a notify failure must never roll back a
  // valid supersession (the DB flip is the source of truth).
  await services.notify?.onVersionEffective(result.newEffectiveVersionId);
  return result;
}
