import type { Pool, PoolClient } from "pg";
import { renderMask } from "../numbering-utils.js";

// Values available to a numbering mask. Extend freely — the parser only
// substitutes tokens that actually appear in the mask.
export interface NumberingTokens {
  DocType: string;
  Department: string;
  Year: number;
  Month?: number;
  Day?: number;
  [key: string]: string | number | undefined;
}

export interface NumberingRule {
  id: string;
  tenantId: string;
  mask: string;
  scopeTokens: string[];
}

/**
 * Deterministic serialization of the scope-defining token VALUES, in the rule's
 * declared order. This becomes dcs_number_sequences.scope_hash — a new scope
 * (new year/dept/type) yields a new hash → a fresh counter starting at 1. That
 * IS the "sequence resets automatically" requirement, with zero cron jobs.
 */
export function computeScopeHash(rule: NumberingRule, tokens: NumberingTokens): {
  hash: string;
  values: Record<string, string | number>;
} {
  const values: Record<string, string | number> = {};
  for (const token of rule.scopeTokens) {
    const v = tokens[token];
    if (v === undefined || v === null) {
      throw new Error(`Numbering scope token "${token}" required by rule ${rule.id} but not provided`);
    }
    values[token] = v;
  }
  const hash = rule.scopeTokens.map((t) => String(values[t])).join("|");
  return { hash, values };
}

/**
 * Atomically reserves the next sequence for a scope. INSERT-or-increment in one
 * statement; the row lock holds to COMMIT so concurrent generators for the SAME
 * scope serialize and never collide, while different scopes never contend.
 * Numbers are consumed permanently (a deleted draft leaves a gap) — standard ISO
 * control-number behaviour.
 */
export async function reserveSequence(
  client: PoolClient,
  rule: NumberingRule,
  tokens: NumberingTokens,
): Promise<number> {
  const { hash, values } = computeScopeHash(rule, tokens);
  // Ambil dari kolam nomor yang DILEPAS lebih dulu (terkecil), supaya dokumen
  // yang batal terbit tidak meninggalkan lubang. FOR UPDATE menahan baris
  // sampai COMMIT, jadi dua generator pada scope yang sama tidak bisa
  // mengambil nomor lepas yang sama.
  const recycled = await client.query<{ seq: string }>(
    `WITH pick AS (
       SELECT id, (SELECT MIN(x) FROM unnest(released) AS x) AS seq
         FROM dcs_number_sequences
        WHERE tenant_id = $1 AND rule_id = $2 AND scope_hash = $3
          AND COALESCE(array_length(released, 1), 0) > 0
        FOR UPDATE
     )
     UPDATE dcs_number_sequences s
        SET released = array_remove(s.released, pick.seq), updated_at = now()
       FROM pick
      WHERE s.id = pick.id
     RETURNING pick.seq AS seq`,
    [rule.tenantId, rule.id, hash],
  );
  if (recycled.rowCount && recycled.rows[0].seq != null) return Number(recycled.rows[0].seq);

  const { rows } = await client.query<{ current_seq: string }>(
    `INSERT INTO dcs_number_sequences (tenant_id, rule_id, scope_hash, scope_values, current_seq)
       VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (tenant_id, rule_id, scope_hash)
       DO UPDATE SET current_seq = dcs_number_sequences.current_seq + 1, updated_at = now()
     RETURNING current_seq`,
    [rule.tenantId, rule.id, hash, JSON.stringify(values)],
  );
  return Number(rows[0].current_seq);
}

/**
 * Kembalikan sebuah sequence ke kolam scope-nya supaya dipakai dokumen
 * berikutnya. Kalau yang dilepas kebetulan nomor TERAKHIR, counter cukup
 * dimundurkan — lebih bersih daripada menyimpannya di kolam. Idempoten.
 */
export async function releaseSequence(
  client: PoolClient,
  params: { tenantId: string; ruleId: string; scopeHash: string; seq: number },
): Promise<boolean> {
  const { rows } = await client.query<{ current_seq: string; released: string[] }>(
    `SELECT current_seq, released FROM dcs_number_sequences
      WHERE tenant_id = $1 AND rule_id = $2 AND scope_hash = $3 FOR UPDATE`,
    [params.tenantId, params.ruleId, params.scopeHash],
  );
  if (rows.length === 0) return false;
  const current = Number(rows[0].current_seq);
  const released = (rows[0].released || []).map(Number);
  if (released.includes(params.seq)) return true; // sudah dilepas sebelumnya
  if (current === params.seq) {
    await client.query(
      `UPDATE dcs_number_sequences SET current_seq = current_seq - 1, updated_at = now()
        WHERE tenant_id = $1 AND rule_id = $2 AND scope_hash = $3`,
      [params.tenantId, params.ruleId, params.scopeHash],
    );
    return true;
  }
  await client.query(
    `UPDATE dcs_number_sequences SET released = array_append(released, $4::bigint), updated_at = now()
      WHERE tenant_id = $1 AND rule_id = $2 AND scope_hash = $3`,
    [params.tenantId, params.ruleId, params.scopeHash, params.seq],
  );
  return true;
}

/** Reserve the counter for this scope, then render the number. */
export async function generateDocumentNumber(
  client: PoolClient,
  rule: NumberingRule,
  tokens: NumberingTokens,
): Promise<{ documentNumber: string; sequence: number; ruleId: string; scopeHash: string }> {
  const sequence = await reserveSequence(client, rule, tokens);
  // scopeHash ikut dikembalikan & disimpan di dokumen: pelepasan nomor nanti
  // harus menyasar baris counter yang persis sama, bukan hasil hitung ulang
  // (token Year/Month berubah seiring waktu).
  const { hash } = computeScopeHash(rule, tokens);
  return { documentNumber: renderMask(rule.mask, tokens, sequence), sequence, ruleId: rule.id, scopeHash: hash };
}

/**
 * Read-only preview of what reserveSequence WOULD hand out next, without
 * touching dcs_number_sequences — plain Pool (no transaction/row lock needed,
 * this never writes). Used to show the document number locked-but-visible on
 * the creation form before the user submits (reserveSequence itself always
 * consumes permanently, so it can't be called just to render a preview).
 * Genuinely a peek: if another document in the same scope gets created
 * between this call and the real submit, the two can diverge — the same
 * accepted tradeoff as the Contract module's consume:false preview.
 */
export async function peekNextSequence(
  pool: Pool,
  rule: NumberingRule,
  tokens: NumberingTokens,
): Promise<number> {
  const { hash } = computeScopeHash(rule, tokens);
  const { rows } = await pool.query<{ current_seq: string }>(
    `SELECT current_seq FROM dcs_number_sequences WHERE tenant_id = $1 AND rule_id = $2 AND scope_hash = $3`,
    [rule.tenantId, rule.id, hash],
  );
  return rows.length > 0 ? Number(rows[0].current_seq) + 1 : 1;
}

/** Render preview: peekNextSequence + renderMask, no counter mutation. */
export async function previewDocumentNumber(
  pool: Pool,
  rule: NumberingRule,
  tokens: NumberingTokens,
): Promise<{ documentNumber: string; sequence: number }> {
  const sequence = await peekNextSequence(pool, rule, tokens);
  return { documentNumber: renderMask(rule.mask, tokens, sequence), sequence };
}
