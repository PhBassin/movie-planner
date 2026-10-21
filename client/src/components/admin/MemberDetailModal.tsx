import React from 'react';
import type { MemberAdminView } from '../../api/members';
import MemberStatusBadge from './MemberStatusBadge';
import Button from '../ui/Button';

interface MemberDetailModalProps {
  member: MemberAdminView;
  onClose: () => void;
  onSuspend: (member: MemberAdminView) => void;
  onReinstate: (member: MemberAdminView) => void;
  onDelete: (member: MemberAdminView) => void;
  canUpdate: boolean;
  canDelete: boolean;
  isSwitchingStatus?: boolean;
}

const formatDate = (dateString: string | null): string => {
  if (!dateString) return '—';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
};

const DetailRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex justify-between py-2 border-b border-gray-100 last:border-b-0">
    <dt className="text-sm font-medium text-gray-500">{label}</dt>
    <dd className="text-sm text-gray-900 text-right">{children}</dd>
  </div>
);

/** The admin Member detail view (issue #65, story 30). */
const MemberDetailModal: React.FC<MemberDetailModalProps> = ({
  member,
  onClose,
  onSuspend,
  onReinstate,
  onDelete,
  canUpdate,
  canDelete,
  isSwitchingStatus = false,
}) => {
  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !isSwitchingStatus) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
      data-testid="dialog-backdrop"
      onClick={handleBackdropClick}
    >
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-900" data-testid="member-detail-heading">
              Member details
            </h2>
            <p className="text-sm text-gray-500 truncate">{member.email}</p>
          </div>
          <MemberStatusBadge status={member.status} />
        </div>

        {/* Content */}
        <div className="px-6 py-4">
          <dl data-testid="member-detail-list">
            <DetailRow label="Email">{member.email}</DetailRow>
            <DetailRow label="Email verified">
              {member.email_verified_at ? formatDate(member.email_verified_at) : 'Not verified'}
            </DetailRow>
            <DetailRow label="Selection (cinemas)">{member.selection_count}</DetailRow>
            <DetailRow label="Submissions">{member.submission_count}</DetailRow>
            <DetailRow label="Appearance">{member.appearance === 'dark' ? 'Dark' : 'Light'}</DetailRow>
            <DetailRow label="Member since">{formatDate(member.created_at)}</DetailRow>
          </dl>

          {member.status === 'suspended' && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-md">
              <p className="text-sm text-red-700">
                This member is suspended: their Sessions are revoked and they cannot
                log in. Their data is kept for reinstatement.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose} disabled={isSwitchingStatus}>
            Close
          </Button>
          {canUpdate && member.status === 'active' && (
            <Button
              variant="warning"
              onClick={() => onSuspend(member)}
              disabled={isSwitchingStatus}
              data-testid="detail-suspend-member"
            >
              {isSwitchingStatus ? 'Suspending...' : 'Suspend'}
            </Button>
          )}
          {canUpdate && member.status === 'suspended' && (
            <Button
              onClick={() => onReinstate(member)}
              disabled={isSwitchingStatus}
              data-testid="detail-reinstate-member"
            >
              {isSwitchingStatus ? 'Reinstating...' : 'Reinstate'}
            </Button>
          )}
          {canDelete && (
            <Button
              variant="danger"
              onClick={() => onDelete(member)}
              disabled={isSwitchingStatus}
              data-testid="detail-delete-member"
            >
              Delete
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default MemberDetailModal;
