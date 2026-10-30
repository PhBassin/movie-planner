import React from 'react';
import type { MemberAdminView } from '../../api/members';

/**
 * A Member's stored Selection choices, with the remembered part called out
 * (ADR 0011 D2) — the Member sees only the active count against their quota,
 * so Staff need both to reconcile what the Member reports.
 */
const MemberSelectionCount: React.FC<{ member: Pick<MemberAdminView, 'selection_count' | 'remembered_selection_count'> }> = ({ member }) => (
  <span data-testid="member-selection-count">
    {member.selection_count}
    {member.remembered_selection_count > 0 && (
      <span className="ml-1 text-gray-400">({member.remembered_selection_count} remembered)</span>
    )}
  </span>
);

export default MemberSelectionCount;
