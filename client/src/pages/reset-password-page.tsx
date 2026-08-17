import React, { useContext, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { confirmPasswordReset } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import PasswordRequirements from '../components/PasswordRequirements.js';
import { validatePassword } from '../utils/userValidators.js';
import { AuthContext } from '../contexts/AuthContext.js';

const ResetPasswordPage: React.FC = () => {
    const [searchParams] = useSearchParams();
    const token = searchParams.get('token');
    const navigate = useNavigate();
    const { logout } = useContext(AuthContext);
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    if (!token) {
        return (
            <div className="max-w-md mx-auto mt-10 px-4 sm:px-6">
                <div className="bg-white p-8 rounded-lg shadow-md text-center">
                    <h2 className="text-2xl font-bold mb-4 text-gray-800">Invalid reset link</h2>
                    <p className="text-gray-600 mb-6">
                        This page expects the link from your password reset email.
                    </p>
                    <Link to="/forgot-password" className="text-blue-600 hover:text-blue-800">
                        Request a new link
                    </Link>
                </div>
            </div>
        );
    }

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setError('');

        if (newPassword !== confirmPassword) {
            setError('Passwords do not match');
            return;
        }

        const passwordError = validatePassword(newPassword);
        if (passwordError) {
            setError(passwordError);
            return;
        }

        setIsLoading(true);
        try {
            await confirmPasswordReset(token, newPassword);
            await logout();
            navigate('/login', { replace: true });
        } catch (err: unknown) {
            if (err instanceof ApiError && err.data?.error) {
                setError(err.data.error);
            } else {
                setError('Could not reset your password. Please request a new link.');
            }
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="max-w-md mx-auto mt-10 px-4 sm:px-6">
            <div className="bg-white p-8 rounded-lg shadow-md">
                <h2 className="text-2xl font-bold mb-6 text-center text-gray-800">Reset your password</h2>

                {error && (
                    <div className="mb-4 bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded text-sm" role="alert">
                        {error}
                    </div>
                )}

                <form onSubmit={handleSubmit}>
                    <div className="mb-4">
                        <label className="block text-gray-700 text-sm font-bold mb-2" htmlFor="new-password">
                            New password
                        </label>
                        <input
                            className="appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500"
                            id="new-password"
                            type="password"
                            value={newPassword}
                            onChange={(event) => setNewPassword(event.target.value)}
                            required
                            disabled={isLoading}
                        />
                        <PasswordRequirements password={newPassword} />
                    </div>

                    <div className="mb-6">
                        <label className="block text-gray-700 text-sm font-bold mb-2" htmlFor="confirm-password">
                            Confirm new password
                        </label>
                        <input
                            className="appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500"
                            id="confirm-password"
                            type="password"
                            value={confirmPassword}
                            onChange={(event) => setConfirmPassword(event.target.value)}
                            required
                            disabled={isLoading}
                        />
                    </div>

                    <button
                        className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 w-full transition-colors disabled:opacity-50"
                        type="submit"
                        disabled={isLoading}
                    >
                        {isLoading ? 'Resetting...' : 'Reset password'}
                    </button>
                </form>
            </div>
        </div>
    );
};

export default ResetPasswordPage;
