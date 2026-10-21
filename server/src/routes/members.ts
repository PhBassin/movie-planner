import express from 'express';
import { parseStrictInt } from '../utils/number.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permission.js';
import { protectedLimiter } from '../middleware/rate-limit.js';
import type { ApiResponse } from '../types/api.js';
import type { MemberAdminRow } from '../db/member-queries.js';
import { ValidationError } from '../utils/errors.js';
import { MemberAdminService } from '../services/member-admin-service.js';

/**
 * Staff routes over the Member base (issue #65). Admin-only in practice: the
 * `members:*` permissions are granted to the admin role alone, so operators
 * never see this surface.
 */

const router = express.Router();
const MAX_LIST_LIMIT = 100;

const actingUserFrom = (req: AuthRequest) => ({ id: req.user!.id, username: req.user!.username });

const parseIdOrThrow = (raw: unknown, label: string): number => {
  const id = parseStrictInt(raw);
  if (Number.isNaN(id)) throw new ValidationError(`Invalid ${label}`);
  return id;
};

router.get('/', protectedLimiter, requireAuth, requirePermission('members:list'), async (req: AuthRequest, res, next) => {
  try {
    const memberService = new MemberAdminService(req.app.get('db'));
    const requestedLimit = req.query.limit ? parseStrictInt(req.query.limit) : MAX_LIST_LIMIT;
    const offset = req.query.offset ? parseStrictInt(req.query.offset) : 0;
    if (Number.isNaN(requestedLimit) || requestedLimit < 1) return next(new ValidationError('Invalid limit parameter'));
    if (Number.isNaN(offset) || offset < 0) return next(new ValidationError('Invalid offset parameter'));
    const members = await memberService.listMembers(
      { limit: Math.min(requestedLimit, MAX_LIST_LIMIT), offset },
      actingUserFrom(req),
    );
    res.json({ success: true, data: members } as ApiResponse<MemberAdminRow[]>);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', protectedLimiter, requireAuth, requirePermission('members:read'), async (req: AuthRequest, res, next) => {
  try {
    const memberService = new MemberAdminService(req.app.get('db'));
    const member = await memberService.getMember(parseIdOrThrow(req.params.id, 'member ID'), actingUserFrom(req));
    res.json({ success: true, data: member } as ApiResponse<MemberAdminRow>);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/suspend', protectedLimiter, requireAuth, requirePermission('members:update'), async (req: AuthRequest, res, next) => {
  try {
    const memberService = new MemberAdminService(req.app.get('db'));
    const member = await memberService.suspendMember(parseIdOrThrow(req.params.id, 'member ID'), actingUserFrom(req));
    res.json({ success: true, data: member } as ApiResponse<MemberAdminRow>);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/reinstate', protectedLimiter, requireAuth, requirePermission('members:update'), async (req: AuthRequest, res, next) => {
  try {
    const memberService = new MemberAdminService(req.app.get('db'));
    const member = await memberService.reinstateMember(parseIdOrThrow(req.params.id, 'member ID'), actingUserFrom(req));
    res.json({ success: true, data: member } as ApiResponse<MemberAdminRow>);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', protectedLimiter, requireAuth, requirePermission('members:delete'), async (req: AuthRequest, res, next) => {
  try {
    const memberService = new MemberAdminService(req.app.get('db'));
    await memberService.deleteMember(parseIdOrThrow(req.params.id, 'member ID'), actingUserFrom(req));
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
