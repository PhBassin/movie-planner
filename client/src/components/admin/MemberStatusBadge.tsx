import React from 'react';
import type { MemberStatus } from '../../api/members';

const STATUS_STYLES: Record<MemberStatus, { label: string; className: string }> = {
  unverified: {
    label: 'Unverified',
    className: 'bg-gray-100 text-gray-700',
  },
  active: {
    label: 'Active',
    className: 'bg-green-100 text-green-800',
  },
  suspended: {
    label: 'Suspended',
    className: 'bg-red-100 text-red-800',
  },
};

/**
 * The Member lifecycle badge (CONTEXT.md → Member): unverified → active,
 * active ↔ suspended, deletion removes the row (no 'deleted' state).
 */
const MemberStatusBadge: React.FC<{ status: MemberStatus }> = ({ status }) => {
  const { label, className } = STATUS_STYLES[status];
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${className}`}
      data-testid={`member-status-${status}`}
    >
      {label}
    </span>
  );
};

export default MemberStatusBadge;
