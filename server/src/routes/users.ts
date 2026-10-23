import express from 'express';
import { parseStrictInt } from '../utils/number.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permission.js';
import { protectedLimiter } from '../middleware/rate-limit.js';
import type { ApiResponse } from '../types/api.js';
import type { UserPublic } from '../types/user.js';
import { actingUserFrom, parseIdOrThrow, parsePaginationOrThrow } from './_helpers/admin-route-helpers.js';
import { UserService } from '../services/user-service.js';

const router = express.Router();

router.get('/', protectedLimiter, requireAuth, requirePermission('users:list'), async (req: AuthRequest, res, next) => {
  try {
    const userService = new UserService(req.app.get('db'));
    const users = await userService.listUsers(parsePaginationOrThrow(req.query), actingUserFrom(req));
    res.json({ success: true, data: users } as ApiResponse<UserPublic[]>);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', protectedLimiter, requireAuth, requirePermission('users:list'), async (req: AuthRequest, res, next) => {
  try {
    const userService = new UserService(req.app.get('db'));
    const user = await userService.getUserById(parseIdOrThrow(req.params.id, 'user ID'), actingUserFrom(req));
    res.json({ success: true, data: user } as ApiResponse<UserPublic>);
  } catch (error) {
    next(error);
  }
});

router.post('/', protectedLimiter, requireAuth, requirePermission('users:create'), async (req: AuthRequest, res, next) => {
  try {
    const userService = new UserService(req.app.get('db'));
    const { username, password, role_id } = req.body;
    const newUser = await userService.createUser({ username, password, roleId: parseStrictInt(role_id) }, actingUserFrom(req));
    res.status(201).json({ success: true, data: newUser } as ApiResponse<UserPublic>);
  } catch (error) {
    next(error);
  }
});

router.put('/:id/role', protectedLimiter, requireAuth, requirePermission('users:update'), async (req: AuthRequest, res, next) => {
  try {
    const userService = new UserService(req.app.get('db'));
    const updated = await userService.updateUserRole(
      parseIdOrThrow(req.params.id, 'user ID'),
      parseStrictInt(req.body.role_id),
      actingUserFrom(req),
    );
    res.json({ success: true, data: updated } as ApiResponse<UserPublic>);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/reset-password', protectedLimiter, requireAuth, requirePermission('users:update'), async (req: AuthRequest, res, next) => {
  try {
    const userService = new UserService(req.app.get('db'));
    const target = await userService.resetPassword(
      parseIdOrThrow(req.params.id, 'user ID'),
      req.body.newPassword,
      actingUserFrom(req),
    );
    res.json({ success: true, data: { user: target } } as ApiResponse<{ user: UserPublic }>);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', protectedLimiter, requireAuth, requirePermission('users:delete'), async (req: AuthRequest, res, next) => {
  try {
    const userService = new UserService(req.app.get('db'));
    await userService.deleteUser(parseIdOrThrow(req.params.id, 'user ID'), actingUserFrom(req));
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;