import React, { useContext, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AuthContext } from '../contexts/AuthContext.js';
import { getMemberProfile, exportMemberData, deleteOwnAccount } from '../api/me.js';
import { ME_QUERY_KEY } from '../api/query-keys.js';
import { getApiErrorMessage } from '../api/client.js';

/** Save a JSON document as a file through a temporary object URL. */
function downloadJson(document_: unknown, filename: string): void {
    const blob = new Blob([JSON.stringify(document_, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

/**
 * The Member's account page (issue #66, ADR 0004): the two RGPD self-service
 * rights — data export (Article 20) and erasure (Article 17, gated by
 * password re-entry). Member-only: Staff accounts are managed by an Admin.
 */
const AccountPage: React.FC = () => {
    const { user, logout } = useContext(AuthContext);
    const navigate = useNavigate();
    const isMember = user?.role_name === 'member';

    const profileQuery = useQuery({
        queryKey: ME_QUERY_KEY,
        queryFn: getMemberProfile,
        enabled: isMember,
    });

    const [isExporting, setIsExporting] = useState(false);
    const [exportError, setExportError] = useState('');

    const [password, setPassword] = useState('');
    const [confirmed, setConfirmed] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState('');

    if (!isMember) {
        return <Navigate to="/" replace />;
    }

    const handleExport = async () => {
        setExportError('');
        setIsExporting(true);
        try {
            const data = await exportMemberData();
            downloadJson(data, `movie-planner-data-${data.exported_at.slice(0, 10)}.json`);
        } catch (err) {
            setExportError(getApiErrorMessage(err, 'Could not export your data. Please try again.'));
        } finally {
            setIsExporting(false);
        }
    };

    const handleDelete = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!confirmed || !password) return;
        setDeleteError('');
        setIsDeleting(true);
        try {
            await deleteOwnAccount(password);
            // The server already ended the Session; leave the protected page
            // before dropping the local user so no login redirect flashes.
            navigate('/', { replace: true });
            logout();
        } catch (err) {
            setDeleteError(getApiErrorMessage(err, 'Could not delete your account. Please try again.'));
            setIsDeleting(false);
        }
    };

    const profile = profileQuery.data;

    return (
        <div className="max-w-2xl mx-auto mt-10 px-4 sm:px-6 space-y-6">
            <h1 className="text-2xl font-bold text-gray-800" data-testid="account-heading">My account</h1>

            {profile && (
                <div className="bg-white p-6 rounded-lg shadow-md">
                    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                        <dt className="font-medium text-gray-500">Email</dt>
                        <dd className="text-gray-900" data-testid="account-email">{profile.email}</dd>
                        <dt className="font-medium text-gray-500">Email verified</dt>
                        <dd className="text-gray-900">{profile.email_verified ? 'Yes' : 'No'}</dd>
                    </dl>
                </div>
            )}

            <section className="bg-white p-6 rounded-lg shadow-md">
                <h2 className="text-lg font-semibold text-gray-800 mb-2">Download my data</h2>
                <p className="text-sm text-gray-600 mb-4">
                    Get a copy of your personal data as a JSON file: your account, your Selection,
                    your appearance and the history of the cinemas you submitted.
                </p>
                {exportError && (
                    <div className="mb-4 bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded text-sm" role="alert">
                        {exportError}
                    </div>
                )}
                <button
                    type="button"
                    onClick={handleExport}
                    disabled={isExporting}
                    className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors disabled:opacity-50"
                    data-testid="export-data-button"
                >
                    {isExporting ? 'Preparing...' : 'Download my data'}
                </button>
            </section>

            <section className="bg-white p-6 rounded-lg shadow-md border border-red-200">
                <h2 className="text-lg font-semibold text-red-700 mb-2">Delete my account</h2>
                <p className="text-sm text-gray-700 mb-2">
                    Your account is deleted immediately and for good: your Selection, your appearance
                    and your submission history are removed and cannot be recovered. Cinemas you added
                    stay in the catalog. You can download your data first.
                </p>
                <p className="text-sm text-gray-700 mb-4">Enter your password to confirm.</p>

                {deleteError && (
                    <div className="mb-4 bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded text-sm" role="alert" data-testid="delete-account-error">
                        {deleteError}
                    </div>
                )}

                <form onSubmit={handleDelete}>
                    <label className="block text-gray-700 text-sm font-bold mb-2" htmlFor="delete-password">
                        Password
                    </label>
                    <input
                        id="delete-password"
                        type="password"
                        autoComplete="current-password"
                        className="appearance-none border rounded w-full py-2 px-3 mb-4 text-gray-700 leading-tight focus:outline-none focus:ring-2 focus:ring-red-500"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        disabled={isDeleting}
                        required
                    />
                    <label className="flex items-start gap-2 text-sm text-gray-700 mb-4">
                        <input
                            type="checkbox"
                            className="mt-1"
                            checked={confirmed}
                            onChange={(e) => setConfirmed(e.target.checked)}
                            disabled={isDeleting}
                            data-testid="delete-account-confirm"
                        />
                        <span>I understand that this cannot be undone.</span>
                    </label>
                    <button
                        type="submit"
                        disabled={isDeleting || !confirmed || !password}
                        className="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 transition-colors disabled:opacity-50"
                        data-testid="delete-account-submit"
                    >
                        {isDeleting ? 'Deleting...' : 'Delete my account'}
                    </button>
                </form>
            </section>
        </div>
    );
};

export default AccountPage;
