import express from 'express';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permission.js';
import { protectedLimiter } from '../middleware/rate-limit.js';
import type { ApiResponse } from '../types/api.js';
import type { MemberAdminRow } from '../db/member-queries.js';
import { actingUserFrom, parseIdOrThrow, parsePaginationOrThrow } from './_helpers/admin-route-helpers.js';
import { MemberAdminService } from '../services/member-admin-service.js';

/**
 * Staff routes over the Member base (issue #65). Admin-only in practice: the
 * `members:*` permissions are granted to the admin role alone, so operators
 * never see this surface.
 */

const router = express.Router();

router.get('/', protectedLimiter, requireAuth, requirePermission('members:list'), async (req: AuthRequest, res, next) => {
  try {
    const memberService = new MemberAdminService(req.app.get('db'));
    const members = await memberService.listMembers(parsePaginationOrThrow(req.query), actingUserFrom(req));
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
