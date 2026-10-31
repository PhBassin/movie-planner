import React, { useState, useEffect, useMemo, useContext, useCallback } from 'react';
import {
  getMembers,
  suspendMember as suspendMemberApi,
  reinstateMember as reinstateMemberApi,
  deleteMember as deleteMemberApi,
} from '../../api/members';
import type { MemberAdminView } from '../../api/members';
import { AuthContext } from '../../contexts/AuthContext';
import MemberStatusBadge from '../../components/admin/MemberStatusBadge';
import MemberDetailModal from '../../components/admin/MemberDetailModal';
import MemberSelectionCount from '../../components/admin/MemberSelectionCount';
import SuspendMemberDialog from '../../components/admin/SuspendMemberDialog';
import DeleteMemberDialog from '../../components/admin/DeleteMemberDialog';
import LinkButton from '../../components/ui/LinkButton';
import Button from '../../components/ui/Button';

const PAGE_SIZE = 50;

/**
 * The Staff Members section (issue #65): list + detail with the three Admin
 * lifecycle actions — suspend (revoke Sessions, block login), reinstate
 * (back to active, data intact), delete (erasure; Theaters stay).
 */
const MembersPage: React.FC = () => {
  const { hasPermission } = useContext(AuthContext);

  const canUpdate = hasPermission('members:update');
  const canDelete = hasPermission('members:delete');

  const [members, setMembers] = useState<MemberAdminView[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasNextPage, setHasNextPage] = useState(false);
  // `loading` gates the first render only; later refetches keep the table
  // (and any open modal) mounted and just flag `refreshing`.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modal/dialog states
  // Track the open detail modal by id so it always shows the freshest row
  // (and closes if that Member disappears from the page after a refetch).
  const [memberToViewId, setMemberToViewId] = useState<number | null>(null);
  const memberToView = memberToViewId === null ? null : members.find((m) => m.id === memberToViewId) ?? null;
  const [memberToSuspend, setMemberToSuspend] = useState<MemberAdminView | null>(null);
  const [memberToDelete, setMemberToDelete] = useState<MemberAdminView | null>(null);
  const [isSwitchingStatus, setIsSwitchingStatus] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [suspendError, setSuspendError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [reinstateError, setReinstateError] = useState<string | null>(null);

  const fetchMembers = useCallback(async () => {
    try {
      setRefreshing(true);
      setError(null);
      // One extra row tells whether a next page exists.
      const data = await getMembers({ limit: PAGE_SIZE + 1, offset });
      if (data.length === 0 && offset > 0) {
        // The page emptied (e.g. its last Member was deleted): step back.
        setOffset((current) => Math.max(0, current - PAGE_SIZE));
        return;
      }
      setHasNextPage(data.length > PAGE_SIZE);
      setMembers(data.slice(0, PAGE_SIZE));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch members');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [offset]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount: the fetcher sets its own loading state (candidate for react-query)
    fetchMembers();
  }, [fetchMembers]);

  const handleSuspend = async (memberId: number) => {
    try {
      setIsSwitchingStatus(true);
      setSuspendError(null);
      await suspendMemberApi(memberId);
      setMemberToSuspend(null);
      await fetchMembers();
    } catch (err) {
      setSuspendError(err instanceof Error ? err.message : 'Failed to suspend member');
    } finally {
      setIsSwitchingStatus(false);
    }
  };

  const handleReinstate = async (member: MemberAdminView) => {
    if (isSwitchingStatus) return;
    try {
      setIsSwitchingStatus(true);
      setReinstateError(null);
      await reinstateMemberApi(member.id);
      await fetchMembers();
    } catch (err) {
      setReinstateError(err instanceof Error ? err.message : 'Failed to reinstate member');
    } finally {
      setIsSwitchingStatus(false);
    }
  };

  const handleDelete = async (memberId: number) => {
    try {
      setIsDeleting(true);
      setDeleteError(null);
      await deleteMemberApi(memberId);
      setMemberToDelete(null);
      setMemberToViewId(null);
      await fetchMembers();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete member');
    } finally {
      setIsDeleting(false);
    }
  };

  // ⚡ PERFORMANCE: cache the Intl.DateTimeFormat instance (see UsersPage)
  const formatterDate = useMemo(() => new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }), []);

  const formatDate = (dateString: string) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '';
    return formatterDate.format(date);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-600">Loading members...</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-gray-900" data-testid="members-heading">
          Members
        </h1>
      </div>

      {/* Error Message (a reinstate failure shows in the detail modal when it is open) */}
      {(error || (reinstateError && !memberToView)) && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-md" data-testid="members-error">
          <p className="text-sm text-red-800">{error ?? reinstateError}</p>
        </div>
      )}

      {/* Empty State */}
      {members.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-600">No members found</p>
        </div>
      ) : (
        /* Members Table */
        <div className="bg-white shadow-md rounded-lg overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200" data-testid="members-table">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Email
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Verified
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Selection
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Submissions
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Member since
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {members.map((member) => (
                <tr key={member.id} className="hover:bg-gray-50" data-testid={`member-row-${member.id}`}>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900">{member.email}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <MemberStatusBadge status={member.status} />
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-gray-500">
                      {member.email_verified_at ? 'Yes' : 'No'}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-gray-500">
                      <MemberSelectionCount member={member} />
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-gray-500">{member.submission_count}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-gray-500">{formatDate(member.created_at)}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <div className="flex justify-end gap-2">
                      <LinkButton
                        onClick={() => {
                          setReinstateError(null);
                          setMemberToViewId(member.id);
                        }}
                        data-testid={`view-member-${member.id}`}
                      >
                        View
                      </LinkButton>
                      {canUpdate && member.status === 'active' && (
                        <LinkButton
                          variant="warning"
                          onClick={() => setMemberToSuspend(member)}
                          data-testid={`suspend-member-${member.id}`}
                        >
                          Suspend
                        </LinkButton>
                      )}
                      {canUpdate && member.status === 'suspended' && (
                        <LinkButton
                          variant="success"
                          disabled={isSwitchingStatus}
                          onClick={() => handleReinstate(member)}
                          data-testid={`reinstate-member-${member.id}`}
                        >
                          Reinstate
                        </LinkButton>
                      )}
                      {canDelete && (
                        <LinkButton
                          variant="danger"
                          onClick={() => setMemberToDelete(member)}
                          data-testid={`delete-member-${member.id}`}
                        >
                          Delete
                        </LinkButton>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {(offset > 0 || hasNextPage) && (
        <div className="flex justify-between items-center mt-4" data-testid="members-pagination">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
            disabled={offset === 0 || refreshing}
            data-testid="members-prev-page"
          >
            Previous
          </Button>
          <span className="text-sm text-gray-600">
            {offset + 1}–{offset + members.length}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setOffset((current) => current + PAGE_SIZE)}
            disabled={!hasNextPage || refreshing}
            data-testid="members-next-page"
          >
            Next
          </Button>
        </div>
      )}

      {/* Detail Modal */}
      {memberToView && (
        <MemberDetailModal
          member={memberToView}
          onClose={() => {
            setMemberToViewId(null);
            setReinstateError(null);
          }}
          onSuspend={(member) => {
            setMemberToSuspend(member);
            setMemberToViewId(null);
          }}
          onReinstate={handleReinstate}
          onDelete={(member) => {
            setMemberToDelete(member);
            setMemberToViewId(null);
          }}
          canUpdate={canUpdate}
          canDelete={canDelete}
          isSwitchingStatus={isSwitchingStatus}
          error={reinstateError}
        />
      )}

      {/* Suspend Dialog */}
      {memberToSuspend && (
        <SuspendMemberDialog
          isOpen={true}
          member={memberToSuspend}
          onClose={() => {
            setMemberToSuspend(null);
            setSuspendError(null);
          }}
          onConfirm={handleSuspend}
          isSuspending={isSwitchingStatus}
          error={suspendError}
        />
      )}

      {/* Delete Dialog */}
      {memberToDelete && (
        <DeleteMemberDialog
          isOpen={true}
          member={memberToDelete}
          onClose={() => {
            setMemberToDelete(null);
            setDeleteError(null);
          }}
          onConfirm={handleDelete}
          isDeleting={isDeleting}
          error={deleteError}
        />
      )}
    </div>
  );
};

export default MembersPage;
