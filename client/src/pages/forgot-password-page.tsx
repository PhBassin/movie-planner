import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { requestPasswordReset } from '../api/auth.js';
import { ApiError } from '../api/client.js';

const ForgotPasswordPage: React.FC = () => {
    const [email, setEmail] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isDone, setIsDone] = useState(false);

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setError('');
        setIsLoading(true);

        try {
            await requestPasswordReset(email);
            setIsDone(true);
        } catch (err: unknown) {
            setError(getApiErrorMessage(err, 'Could not send the reset email. Please try again.'));
        } finally {
            setIsLoading(false);
        }
    };

    if (isDone) {
        return (
            <div className="max-w-md mx-auto mt-10 px-4 sm:px-6">
                <div className="bg-white p-8 rounded-lg shadow-md text-center">
                    <h2 className="text-2xl font-bold mb-4 text-gray-800">Check your inbox</h2>
                    <p className="text-gray-600 mb-6">
                        If an account exists for that email address, a password reset link is on its way.
                    </p>
                    <Link
                        to="/login"
                        className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
                    >
                        Back to sign in
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-md mx-auto mt-10 px-4 sm:px-6">
            <div className="bg-white p-8 rounded-lg shadow-md">
                <h2 className="text-2xl font-bold mb-2 text-center text-gray-800">Forgot your password?</h2>
                <p className="text-gray-600 text-center mb-6">
                    Enter your email and we will send a password reset link if an account exists.
                </p>

                {error && (
                    <div className="mb-4 bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded text-sm" role="alert">
                        {error}
                    </div>
                )}

                <form onSubmit={handleSubmit}>
                    <div className="mb-6">
                        <label className="block text-gray-700 text-sm font-bold mb-2" htmlFor="email">
                            Email
                        </label>
                        <input
                            className="appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500"
                            id="email"
                            type="email"
                            placeholder="you@example.com"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            required
                            disabled={isLoading}
                        />
                    </div>

                    <button
                        className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 w-full transition-colors disabled:opacity-50"
                        type="submit"
                        disabled={isLoading}
                    >
                        {isLoading ? 'Sending...' : 'Send reset link'}
                    </button>
                </form>

                <p className="mt-4 text-center text-sm text-gray-600">
                    Remember your password?{' '}
                    <Link to="/login" className="text-blue-600 hover:text-blue-800">
                        Sign in
                    </Link>
                </p>
            </div>
        </div>
    );
};

function getApiErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof ApiError && error.data?.error) return error.data.error;
    return fallback;
}

export default ForgotPasswordPage;
