import React, { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { verifyEmail, resendVerification } from '../api/auth';
import { ApiError } from '../api/client';

type VerifyState = 'verifying' | 'missing' | 'success' | 'error';

/**
 * `/verify?token=...` — the landing page for the Member email-verification
 * link (CONTEXT.md → Member lifecycle: unverified → active). The token is
 * consumed on arrival; an expired or unknown link offers the resend path.
 */
const VerifyEmailPage: React.FC = () => {
    const [searchParams] = useSearchParams();
    const [state, setState] = useState<VerifyState>(() =>
        searchParams.get('token') ? 'verifying' : 'missing',
    );
    const [error, setError] = useState('');
    const [email, setEmail] = useState('');
    const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle');
    // Guard against React 18 StrictMode double-invoking the effect (the token
    // is single-use; the second consume would fail).
    const consumed = useRef(false);

    useEffect(() => {
        const token = searchParams.get('token');
        if (!token || consumed.current) return;
        consumed.current = true;

        verifyEmail(token)
            .then(() => setState('success'))
            .catch((err: unknown) => {
                if (err instanceof ApiError && err.data?.error) {
                    setError(err.data.error);
                } else {
                    setError('This verification link is invalid or has expired.');
                }
                setState('error');
            });
    }, [searchParams]);

    const handleResend = async (e: React.FormEvent) => {
        e.preventDefault();
        setResendState('sending');
        try {
            await resendVerification(email);
            setResendState('sent');
        } catch {
            // The endpoint is enumeration-safe and always 200; only a network
            // failure lands here.
            setResendState('idle');
            setError('Could not send the email. Please try again.');
        }
    };

    return (
        <div className="max-w-md mx-auto mt-10 px-4 sm:px-6">
            <div className="bg-white p-8 rounded-lg shadow-md text-center">
                {state === 'verifying' && (
                    <>
                        <h2 className="text-2xl font-bold mb-4 text-gray-800">Verifying your email…</h2>
                        <p className="text-gray-600">Hold on while we confirm your address.</p>
                    </>
                )}

                {state === 'success' && (
                    <>
                        <h2 className="text-2xl font-bold mb-4 text-gray-800">Email verified</h2>
                        <p className="text-gray-600 mb-6">
                            Your email address is confirmed and your account is now active.
                        </p>
                        <Link
                            to="/login"
                            className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
                        >
                            Go to sign in
                        </Link>
                    </>
                )}

                {(state === 'error' || state === 'missing') && (
                    <>
                        <h2 className="text-2xl font-bold mb-4 text-gray-800">
                            {state === 'missing' ? 'No verification token' : 'Verification failed'}
                        </h2>
                        <p className="text-gray-600 mb-6" role="alert">
                            {state === 'missing'
                                ? 'This page expects the link from your verification email.'
                                : error}
                        </p>

                        {resendState === 'sent' ? (
                            <p className="text-gray-600">
                                If an unverified account exists for this email, a fresh verification link is on its way.
                            </p>
                        ) : (
                            <form onSubmit={handleResend} className="text-left">
                                <label className="block text-gray-700 text-sm font-bold mb-2" htmlFor="resend-email">
                                    Resend the verification email
                                </label>
                                <input
                                    className="appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
                                    id="resend-email"
                                    type="email"
                                    placeholder="you@example.com"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    required
                                    disabled={resendState === 'sending'}
                                />
                                <button
                                    className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 w-full transition-colors disabled:opacity-50"
                                    type="submit"
                                    disabled={resendState === 'sending'}
                                >
                                    {resendState === 'sending' ? 'Sending…' : 'Resend verification email'}
                                </button>
                            </form>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};

export default VerifyEmailPage;
