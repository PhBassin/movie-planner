import { Link } from 'react-router-dom';
import { useMemberNotifications, type MemberNotificationToast } from '../hooks/useMemberNotifications.js';

const TOAST_STYLES: Record<MemberNotificationToast['kind'], string> = {
  success: 'border-green-200 bg-green-50 text-green-900',
  'cap-blocked': 'border-amber-200 bg-amber-50 text-amber-900',
  error: 'border-red-200 bg-red-50 text-red-900',
};

export default function MemberNotifications() {
  const { toast, dismiss } = useMemberNotifications();

  if (!toast) return null;

  return (
    <div
      className={`fixed bottom-6 right-6 z-50 flex max-w-sm items-start gap-4 rounded-xl border px-4 py-3 shadow-lg ${TOAST_STYLES[toast.kind]}`}
      role="alert"
      data-testid="member-notification"
      data-kind={toast.kind}
    >
      <span className="flex-1">
        {toast.message}
        {toast.actions?.map((action) => (
          <Link
            key={action.to}
            to={action.to}
            className="ml-2 font-semibold underline underline-offset-2 hover:opacity-80"
            onClick={dismiss}
          >
            {action.label}
          </Link>
        ))}
      </span>
      <button
        type="button"
        className="text-sm font-semibold hover:opacity-80"
        aria-label="Fermer la notification"
        onClick={dismiss}
      >
        Fermer
      </button>
    </div>
  );
}
