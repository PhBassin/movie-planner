import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MembersPage from './MembersPage';
import * as membersApi from '../../api/members';
import type { MemberAdminView } from '../../api/members';
import type { PermissionName } from '../../types/role';
import { AuthContext } from '../../contexts/AuthContext';

// Mock the API module
vi.mock('../../api/members');

const makeMember = (overrides: Partial<MemberAdminView> = {}): MemberAdminView => ({
  id: 7,
  username: 'member@example.com',
  email: 'member@example.com',
  role_name: 'member',
  status: 'active',
  email_verified_at: '2026-01-02T00:00:00Z',
  appearance: 'light',
  selection_count: 3,
  remembered_selection_count: 0,
  submission_count: 1,
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

const mockAuthContext = {
  isAuthenticated: true,
  token: 'mock-token',
  user: {
    id: 1,
    username: 'admin',
    role_id: 1,
    role_name: 'admin',
    is_system_role: true,
    permissions: ['members:list', 'members:read', 'members:update', 'members:delete'] as PermissionName[],
  },
  login: vi.fn(),
  logout: vi.fn(),
  isAdmin: true,
  hasPermission: vi.fn<(p: PermissionName) => boolean>(() => true),
};

const renderWithAuth = (ui: React.ReactElement, authOverrides?: Partial<typeof mockAuthContext>) =>
  render(
    <AuthContext.Provider value={{ ...mockAuthContext, ...authOverrides }}>
      {ui}
    </AuthContext.Provider>
  );

describe('MembersPage', () => {
  const activeMember = makeMember();
  const suspendedMember = makeMember({
    id: 8,
    email: 'abuse@example.com',
    status: 'suspended',
    email_verified_at: '2026-01-03T00:00:00Z',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext.hasPermission = vi.fn<(p: PermissionName) => boolean>(() => true);
    vi.mocked(membersApi.getMembers).mockResolvedValue([activeMember, suspendedMember]);
  });

  it('renders the members table with lifecycle columns', async () => {
    renderWithAuth(<MembersPage />);

    expect(await screen.findByTestId('members-table')).toBeInTheDocument();
    expect(screen.getByText('member@example.com')).toBeInTheDocument();
    expect(screen.getByText('abuse@example.com')).toBeInTheDocument();
    expect(screen.getAllByTestId('member-status-active')).toHaveLength(1);
    expect(screen.getAllByTestId('member-status-suspended')).toHaveLength(1);
  });

  it('shows the empty state when there are no members', async () => {
    vi.mocked(membersApi.getMembers).mockResolvedValue([]);

    renderWithAuth(<MembersPage />);

    expect(await screen.findByText(/no members found/i)).toBeInTheDocument();
  });

  it('shows a suspend action only for active members and reinstate only for suspended ones', async () => {
    renderWithAuth(<MembersPage />);

    await screen.findByTestId('members-table');

    expect(screen.getByTestId('suspend-member-7')).toBeInTheDocument();
    expect(screen.queryByTestId('reinstate-member-7')).not.toBeInTheDocument();
    expect(screen.getByTestId('reinstate-member-8')).toBeInTheDocument();
    expect(screen.queryByTestId('suspend-member-8')).not.toBeInTheDocument();
  });

  it('opens the detail modal from a row and shows the lifecycle slice', async () => {
    renderWithAuth(<MembersPage />);

    await screen.findByTestId('members-table');
    await userEvent.click(screen.getByTestId('view-member-7'));

    expect(screen.getByTestId('member-detail-heading')).toBeInTheDocument();
    expect(screen.getByTestId('member-detail-list')).toHaveTextContent('member@example.com');
    expect(screen.getByTestId('detail-suspend-member')).toBeInTheDocument();
  });

  it('suspends through the confirmation dialog and refreshes the list', async () => {
    vi.mocked(membersApi.suspendMember).mockResolvedValue(makeMember({ status: 'suspended' }));
    renderWithAuth(<MembersPage />);

    await screen.findByTestId('members-table');
    await userEvent.click(screen.getByTestId('suspend-member-7'));

    await userEvent.click(screen.getByTestId('confirm-suspend-member'));

    await waitFor(() => expect(membersApi.suspendMember).toHaveBeenCalledWith(7));
    await waitFor(() => expect(membersApi.getMembers).toHaveBeenCalledTimes(2));
  });

  it('surfaces a suspend error inline in the dialog', async () => {
    vi.mocked(membersApi.suspendMember).mockRejectedValue(new Error('Member is already suspended'));
    renderWithAuth(<MembersPage />);

    await screen.findByTestId('members-table');
    await userEvent.click(screen.getByTestId('suspend-member-7'));
    await userEvent.click(screen.getByTestId('confirm-suspend-member'));

    expect(await screen.findByText(/member is already suspended/i)).toBeInTheDocument();
  });

  it('reinstates directly from the row', async () => {
    vi.mocked(membersApi.reinstateMember).mockResolvedValue(makeMember({ id: 8, status: 'active' }));
    renderWithAuth(<MembersPage />);

    await screen.findByTestId('members-table');
    await userEvent.click(screen.getByTestId('reinstate-member-8'));

    await waitFor(() => expect(membersApi.reinstateMember).toHaveBeenCalledWith(8));
    await waitFor(() => expect(membersApi.getMembers).toHaveBeenCalledTimes(2));
  });

  it('deletes through the confirmation dialog', async () => {
    vi.mocked(membersApi.deleteMember).mockResolvedValue(undefined);
    renderWithAuth(<MembersPage />);

    await screen.findByTestId('members-table');
    await userEvent.click(screen.getByTestId('delete-member-7'));
    await userEvent.click(screen.getByTestId('confirm-delete-member'));

    await waitFor(() => expect(membersApi.deleteMember).toHaveBeenCalledWith(7));
    await waitFor(() => expect(membersApi.getMembers).toHaveBeenCalledTimes(2));
  });

  it('hides lifecycle actions without members:update / members:delete', async () => {
    mockAuthContext.hasPermission = vi.fn<(p: PermissionName) => boolean>((p) => p === 'members:list');
    renderWithAuth(<MembersPage />);

    await screen.findByTestId('members-table');

    expect(screen.getByTestId('view-member-7')).toBeInTheDocument();
    expect(screen.queryByTestId('suspend-member-7')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reinstate-member-8')).not.toBeInTheDocument();
    expect(screen.queryByTestId('delete-member-7')).not.toBeInTheDocument();
  });

  it('shows the fetch error banner when the list call fails', async () => {
    vi.mocked(membersApi.getMembers).mockRejectedValue(new Error('boom'));

    renderWithAuth(<MembersPage />);

    expect(await screen.findByTestId('members-error')).toHaveTextContent(/boom/i);
  });

  it('requests one page plus a sentinel row and paginates with Next / Previous', async () => {
    const page = Array.from({ length: 51 }, (_, i) => makeMember({ id: 100 + i, email: `m${i}@example.com` }));
    vi.mocked(membersApi.getMembers)
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([makeMember({ id: 500, email: 'last@example.com' })])
      .mockResolvedValueOnce(page);
    renderWithAuth(<MembersPage />);

    await screen.findByTestId('members-table');
    expect(membersApi.getMembers).toHaveBeenLastCalledWith({ limit: 51, offset: 0 });
    // The sentinel row is not rendered.
    expect(screen.getAllByTestId(/^member-row-/)).toHaveLength(50);
    expect(screen.getByTestId('members-prev-page')).toBeDisabled();

    await userEvent.click(screen.getByTestId('members-next-page'));
    await waitFor(() => expect(membersApi.getMembers).toHaveBeenLastCalledWith({ limit: 51, offset: 50 }));
    expect(await screen.findByText('last@example.com')).toBeInTheDocument();
    expect(screen.getByTestId('members-next-page')).toBeDisabled();

    await userEvent.click(screen.getByTestId('members-prev-page'));
    await waitFor(() => expect(membersApi.getMembers).toHaveBeenLastCalledWith({ limit: 51, offset: 0 }));
  });

  it('hides pagination when everything fits on one page', async () => {
    renderWithAuth(<MembersPage />);

    await screen.findByTestId('members-table');
    expect(screen.queryByTestId('members-pagination')).not.toBeInTheDocument();
  });

  it('shows a reinstate failure inside the open detail modal', async () => {
    vi.mocked(membersApi.reinstateMember).mockRejectedValue(new Error('Member is not suspended'));
    renderWithAuth(<MembersPage />);

    await screen.findByTestId('members-table');
    await userEvent.click(screen.getByTestId('view-member-8'));
    await userEvent.click(screen.getByTestId('detail-reinstate-member'));

    expect(await screen.findByTestId('member-detail-error')).toHaveTextContent('Member is not suspended');
    expect(screen.queryByTestId('members-error')).not.toBeInTheDocument();
  });

  it('keeps the table and modal mounted while refetching after an action', async () => {
    let resolveRefetch: (rows: MemberAdminView[]) => void = () => {};
    vi.mocked(membersApi.reinstateMember).mockResolvedValue(makeMember({ id: 8, status: 'active' }));
    vi.mocked(membersApi.getMembers)
      .mockResolvedValueOnce([activeMember, suspendedMember])
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefetch = resolve; }));
    renderWithAuth(<MembersPage />);

    await screen.findByTestId('members-table');
    await userEvent.click(screen.getByTestId('view-member-8'));
    await userEvent.click(screen.getByTestId('detail-reinstate-member'));

    await waitFor(() => expect(membersApi.getMembers).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/loading members/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('members-table')).toBeInTheDocument();
    expect(screen.getByTestId('member-detail-heading')).toBeInTheDocument();

    resolveRefetch([activeMember, makeMember({ id: 8, email: 'abuse@example.com', status: 'active' })]);
    await waitFor(() => expect(screen.queryByTestId('detail-reinstate-member')).not.toBeInTheDocument());
  });

  it('disables the row Reinstate while a status change is in flight', async () => {
    vi.mocked(membersApi.reinstateMember).mockImplementation(() => new Promise(() => {}));
    renderWithAuth(<MembersPage />);

    await screen.findByTestId('members-table');
    await userEvent.click(screen.getByTestId('reinstate-member-8'));

    expect(screen.getByTestId('reinstate-member-8')).toBeDisabled();
    await userEvent.click(screen.getByTestId('reinstate-member-8'));
    expect(membersApi.reinstateMember).toHaveBeenCalledTimes(1);
  });
});
