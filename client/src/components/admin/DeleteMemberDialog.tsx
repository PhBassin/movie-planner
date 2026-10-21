import React from 'react';
import type { MemberAdminView } from '../../api/members';

interface DeleteMemberDialogProps {
  isOpen: boolean;
  member: MemberAdminView;
  onClose: () => void;
  onConfirm: (memberId: number) => void;
  isDeleting?: boolean;
  error?: string | null;
}

/**
 * Confirmation for the Admin-mediated Member erasure path (ADR 0004): the
 * account and Member-owned data are removed for good; Theaters the Member
 * introduced remain in the single-source catalog.
 */
const DeleteMemberDialog: React.FC<DeleteMemberDialogProps> = ({
  isOpen,
  member,
  onClose,
  onConfirm,
  isDeleting = false,
  error = null,
}) => {
  if (!isOpen) {
    return null;
  }

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !isDeleting) {
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
          <h2 className="text-xl font-semibold text-gray-900">Delete Member</h2>
        </div>

        {/* Content */}
        <div className="px-6 py-4">
          <p className="text-gray-700 mb-4">
            Are you sure you want to delete member{' '}
            <span className="font-semibold">{member.email}</span>?
          </p>

          <div className="bg-red-50 border border-red-200 rounded-md p-3">
            <p className="text-sm text-red-800 font-medium">
              ⚠️ This action cannot be undone
            </p>
            <p className="text-sm text-red-700 mt-1">
              The account and all member-owned data (Selection, Appearance,
              submissions, sessions) will be permanently deleted. Theaters they
              introduced remain in the catalog.
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
            disabled={isDeleting}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(member.id)}
            disabled={isDeleting}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="confirm-delete-member"
          >
            {isDeleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeleteMemberDialog;
