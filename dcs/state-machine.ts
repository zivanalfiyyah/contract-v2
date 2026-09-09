export type VersionStatus =
  | "draft" | "under_review" | "approved" | "effective" | "superseded";

// The ONLY legal moves. Anything absent is rejected before it can touch the DB,
// so illegal jumps (draft → effective, reviving a superseded version) can never
// occur even if an API caller asks for them.
const TRANSITIONS: Record<VersionStatus, VersionStatus[]> = {
  draft:        ["under_review"],
  under_review: ["approved", "draft"],
  approved:     ["effective", "under_review"],
  effective:    ["superseded"],
  superseded:   [],
};

export function isLegalTransition(from: VersionStatus, to: VersionStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: VersionStatus, to: VersionStatus): void {
  if (!isLegalTransition(from, to)) {
    throw new Error(`Illegal DCS state transition: ${from} → ${to}`);
  }
}

export type VersionBump = "revisi" | "terbitan";

/**
 * Next (Terbitan, Revisi) pair.
 *   revisi   → same major, minor + 1
 *   terbitan → major + 1, minor RESET to 0
 * Centralized so the "minor resets on major bump" rule lives in one place.
 */
export function nextVersionNumber(
  current: { major: number; minor: number },
  bump: VersionBump,
): { major: number; minor: number } {
  return bump === "terbitan"
    ? { major: current.major + 1, minor: 0 }
    : { major: current.major, minor: current.minor + 1 };
}
