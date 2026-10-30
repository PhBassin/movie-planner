import React from 'react';
import type { MemberAdminView } from '../../api/members';

interface SuspendMemberDialogProps {
  isOpen: boolean;
  member: MemberAdminView;
  onClose: () => void;
  onConfirm: (memberId: number) => void;
  isSuspending?: boolean;
  error?: string | null;
}

/**
 * Confirmation for the reactive abuse control (CONTEXT.md → Member): the
 * Member's Sessions are revoked immediately and they cannot log in until
 * reinstated. Reversible — Selection, Appearance and submissions persist.
 */
const SuspendMemberDialog: React.FC<SuspendMemberDialogProps> = ({
  isOpen,
  member,
  onClose,
  onConfirm,
  isSuspending = false,
  error = null,
}) => {
  if (!isOpen) {
    return null;
  }

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !isSuspending) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
      data-testid="dialog-backdrop"
      onClick={handleBackdropClick}
    >
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">Suspend Member</h2>
        </div>

        {/* Content */}
        <div className="px-6 py-4">
          <p className="text-gray-700 mb-4">
            Suspend member <span className="font-semibold">{member.email}</span>?
          </p>

          <div className="bg-amber-50 border border-amber-200 rounded-md p-3">
            <p className="text-sm text-amber-800 font-medium">
              Their Sessions are revoked immediately
            </p>
            <p className="text-sm text-amber-700 mt-1">
              The member cannot log in until reinstated. Their Selection, Appearance and
              submissions are kept for reinstatement.
            </p>
          </div>

          {/* Error Display */}
          {error && (
            <div className="mt-4 p-3 bg-red-100 border border-red-300 rounded-md">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isSuspending}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(member.id)}
            disabled={isSuspending}
            className="px-4 py-2 text-sm font-medium text-white bg-amber-600 rounded-md hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="confirm-suspend-member"
          >
            {isSuspending ? 'Suspending...' : 'Suspend'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SuspendMemberDialog;
