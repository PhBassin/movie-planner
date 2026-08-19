// Role and permission types

// Canonical message for endpoints restricted to Member accounts; shared by
// requireMember middleware and service-layer role guards.
export const MEMBER_ONLY_ENDPOINT_MESSAGE = 'This endpoint is for member accounts';

export interface Role {
  id: number;
  name: string;
  description: string | null;
  is_system: boolean;
  created_at: string;
}

export interface Permission {
  id: number;
  name: string;
  description: string | null;
  category: string;
  created_at: string;
}

export interface RoleWithPermissions extends Role {
  permissions: Permission[];
}

export interface PermissionCategoryLabel {
  id: number;
  category_key: string;
  label_en: string;
  label_fr: string;
  created_at: string;
  updated_at: string;
}

// All possible permission strings (used for type safety)
export type PermissionName =
  | 'users:list' | 'users:create' | 'users:update' | 'users:delete' | 'users:read'
  | 'scraper:trigger' | 'scraper:trigger_single'
  | 'scraper:schedules:list' | 'scraper:schedules:create' | 'scraper:schedules:update' | 'scraper:schedules:delete'
  | 'theaters:create' | 'theaters:update' | 'theaters:delete' | 'theaters:read'
  | 'settings:read' | 'settings:update' | 'settings:reset' | 'settings:export' | 'settings:import'
  | 'reports:list' | 'reports:view'
  | 'system:info' | 'system:health' | 'system:migrations'
  | 'roles:read' | 'roles:list' | 'roles:create' | 'roles:update' | 'roles:delete'
  | 'ratelimits:read' | 'ratelimits:update' | 'ratelimits:reset' | 'ratelimits:audit';
