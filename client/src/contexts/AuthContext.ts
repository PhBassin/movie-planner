import { createContext } from 'react';
import type { PermissionName } from '../types/role';

export interface User {
    id: number;
    username: string;
    role_id: number;
    role_name: string;
    is_system_role: boolean;
    permissions: PermissionName[];
}

interface AuthContextType {
    isAuthenticated: boolean;
    user: User | null;
    isAdmin: boolean;
    hasPermission: (permission: PermissionName) => boolean;
    login: (user: User) => void;
    /**
     * End the session. `skipServerLogout` drops only the local user, for when
     * the server already ended the Session (e.g. Member self-erasure): the
     * user is cleared synchronously, with no `/api/auth/logout` round-trip.
     */
    logout: (options?: { skipServerLogout?: boolean }) => void;
}

export const AuthContext = createContext<AuthContextType>({
    isAuthenticated: false,
    user: null,
    isAdmin: false,
    hasPermission: () => false,
    login: () => { },
    logout: () => { },
});
