import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../db/index.js';
import {
  activateSelection,
  getActiveTheater,
  lockMemberForSelection,
  getSelection,
  getSelectionChoice,
  getSelectionSnapshot,
  insertSelection,
  removeSelection,
} from '../db/selection-queries.js';
import { ForbiddenError, NotFoundError } from '../utils/errors.js';
import { applySelectionAdd, MAX_SELECTION_CHOICES, SelectionService } from './selection-service.js';

vi.mock('../db/selection-queries.js', () => ({
  activateSelection: vi.fn(),
  getActiveTheater: vi.fn(),
  lockMemberForSelection: vi.fn(),
  getSelection: vi.fn(),
  getSelectionChoice: vi.fn(),
  getSelectionSnapshot: vi.fn(),
  insertSelection: vi.fn(),
  removeSelection: vi.fn(),
}));

describe('SelectionService', () => {
  const transactionDb = {} as DB;
  const db = {
    transaction: vi.fn(async (callback: (client: DB) => Promise<unknown>) => callback(transactionDb)),
  } as unknown as DB;
  let service: SelectionService;

  // The snapshot query (one statement): Subscription state, counts, projected Theaters.
  let paidThrough = false;
  let projectedTheaterIds: string[] = [];
  const counts = (active: number, total = active) =>
    vi.mocked(getSelectionSnapshot).mockImplementation(async () => ({
      paidThrough, active, total, projectedTheaterIds,
    }));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('BILLING_PROVIDER', 'fake');
    service = new SelectionService(db);
    vi.mocked(lockMemberForSelection).mockResolvedValue({ id: 7, role_name: 'member', status: 'active', email_verified_at: null });
    vi.mocked(getActiveTheater).mockResolvedValue({ id: 'C0001', name: 'UGC Opéra', status: 'active' });
    vi.mocked(getSelectionChoice).mockResolvedValue(undefined);
    paidThrough = false;
    projectedTheaterIds = [];
    counts(0);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('add', () => {
    it('adds an active theater inside a member-row transaction', async () => {
      const theater = await service.add(7, 'C0001');

      expect(theater.id).toBe('C0001');
      expect(db.transaction).toHaveBeenCalledOnce();
      expect(lockMemberForSelection).toHaveBeenCalledWith(transactionDb, 7);
      // The Entitlement is read inside the locked transaction, never from the token.
      expect(getSelectionSnapshot).toHaveBeenCalledWith(transactionDb, 7, { rememberedCountsAsActive: false });
      expect(insertSelection).toHaveBeenCalledWith(transactionDb, 7, 'C0001');
    });

    it('rejects a provisioning or missing theater', async () => {
      vi.mocked(getActiveTheater).mockResolvedValue(undefined);

      await expect(service.add(7, 'C0001')).rejects.toBeInstanceOf(NotFoundError);
      expect(getSelectionSnapshot).not.toHaveBeenCalled();
    });

    it('rejects a deleted member', async () => {
      vi.mocked(lockMemberForSelection).mockResolvedValue(undefined);

      await expect(service.add(7, 'C0001')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('rejects Staff accounts even when called directly', async () => {
      vi.mocked(lockMemberForSelection).mockResolvedValue({ id: 1, role_name: 'admin', status: 'active', email_verified_at: null });

      await expect(service.add(1, 'C0001')).rejects.toBeInstanceOf(ForbiddenError);
      expect(getActiveTheater).not.toHaveBeenCalled();
    });

    it('rejects a 4th active theater for a free Member with the quota conflict and fresh usage', async () => {
      counts(3);

      await expect(service.add(7, 'C0001')).rejects.toEqual(
        expect.objectContaining({
          statusCode: 409,
          message: expect.stringContaining('Free offer allows 3 active theaters'),
          details: [expect.objectContaining({
            reason: 'quota_reached',
            usage: expect.objectContaining({ offer: 'free', activeCount: 3, selectionQuota: 3 }),
          })],
        }),
      );
      expect(insertSelection).not.toHaveBeenCalled();
    });

    it('rejects a 51st active theater for a premium Member', async () => {
      paidThrough = true;
      counts(MAX_SELECTION_CHOICES);

      await expect(service.add(7, 'C0001')).rejects.toEqual(
        expect.objectContaining({
          statusCode: 409,
          message: 'Selection contains 50 active theaters; maximum is 50',
        }),
      );
      expect(insertSelection).not.toHaveBeenCalled();
    });

    it('rejects a new choice when active + remembered already reach 50', async () => {
      counts(2, MAX_SELECTION_CHOICES);

      await expect(service.add(7, 'C0001')).rejects.toEqual(
        expect.objectContaining({
          statusCode: 409,
          details: [expect.objectContaining({ reason: 'choices_full' })],
        }),
      );
      expect(insertSelection).not.toHaveBeenCalled();
    });
  });

  describe('applySelectionAdd (the one policy)', () => {
    it('keeps an active choice idempotent without consuming a slot, even at quota', async () => {
      vi.mocked(getSelectionChoice).mockResolvedValue({ active: true });
      counts(3);

      await expect(applySelectionAdd(transactionDb, 7, 'C0001')).resolves.toBe('already_active');
      expect(getSelectionSnapshot).not.toHaveBeenCalled();
      expect(insertSelection).not.toHaveBeenCalled();
    });

    it('activates a remembered choice below quota without inserting', async () => {
      vi.mocked(getSelectionChoice).mockResolvedValue({ active: false });
      counts(2, 10);

      await expect(applySelectionAdd(transactionDb, 7, 'C0001')).resolves.toBe('activated');
      expect(activateSelection).toHaveBeenCalledWith(transactionDb, 7, 'C0001');
      expect(insertSelection).not.toHaveBeenCalled();
    });

    it('activates a remembered choice even when the total is at 50 (it already counts)', async () => {
      vi.mocked(getSelectionChoice).mockResolvedValue({ active: false });
      counts(2, MAX_SELECTION_CHOICES);

      await expect(applySelectionAdd(transactionDb, 7, 'C0001')).resolves.toBe('activated');
    });

    it('refuses to activate a remembered choice at quota', async () => {
      vi.mocked(getSelectionChoice).mockResolvedValue({ active: false });
      counts(3, 5);

      await expect(applySelectionAdd(transactionDb, 7, 'C0001')).resolves.toBe('quota_reached');
      expect(activateSelection).not.toHaveBeenCalled();
    });

    it('never stores a new choice as remembered: quota wins before the total bound', async () => {
      counts(3, MAX_SELECTION_CHOICES);

      await expect(applySelectionAdd(transactionDb, 7, 'C0001')).resolves.toBe('quota_reached');
      expect(insertSelection).not.toHaveBeenCalled();
    });

    it('lets a premium Member add a 4th theater', async () => {
      paidThrough = true;
      counts(3);

      await expect(applySelectionAdd(transactionDb, 7, 'C0001')).resolves.toBe('added');
      expect(insertSelection).toHaveBeenCalledWith(transactionDb, 7, 'C0001');
    });

    describe('while billing is disabled (production today)', () => {
      beforeEach(() => vi.stubEnv('BILLING_PROVIDER', 'disabled'));

      it('keeps 50 for every Member, whatever the Subscription', async () => {
        counts(3, 3);

        await expect(applySelectionAdd(transactionDb, 7, 'C0001')).resolves.toBe('added');
        expect(getSelectionChoice).toHaveBeenCalledWith(transactionDb, 7, 'C0001', { rememberedCountsAsActive: true });
        expect(getSelectionSnapshot).toHaveBeenCalledWith(transactionDb, 7, { rememberedCountsAsActive: true });
      });

      it('counts remembered choices as active: at 50 stored choices the add is rejected', async () => {
        // The query folds remembered choices into `active` under this view.
        counts(MAX_SELECTION_CHOICES, MAX_SELECTION_CHOICES);

        await expect(applySelectionAdd(transactionDb, 7, 'C0001')).resolves.toBe('quota_reached');
      });

      it('treats a remembered choice as already active', async () => {
        // The query reports a remembered choice as active under this view.
        vi.mocked(getSelectionChoice).mockResolvedValue({ active: true });

        await expect(applySelectionAdd(transactionDb, 7, 'C0001')).resolves.toBe('already_active');
        expect(activateSelection).not.toHaveBeenCalled();
      });
    });
  });

  describe('usage and projection', () => {
    it('reports the free offer, active and remembered counts', async () => {
      counts(2, 5);

      await expect(service.usage(7)).resolves.toEqual({
        offer: 'free',
        activeCount: 2,
        rememberedCount: 3,
        selectionQuota: 3,
        choiceLimit: 50,
        overQuota: false,
      });
    });

    it('derives the over-quota state when a free Member holds more than 3 active choices', async () => {
      projectedTheaterIds = ['C0001', 'C0002', 'C0003', 'C0004', 'C0005'];
      counts(5);

      await expect(service.usage(7)).resolves.toEqual(expect.objectContaining({ overQuota: true }));
      await expect(service.projection(7)).resolves.toEqual({ overQuota: true });
    });

    it('projects the snapshot Theaters from the same single read as the quota check', async () => {
      projectedTheaterIds = ['C0001', 'C0002'];
      counts(2, 4);

      await expect(service.projection(7)).resolves.toEqual({ overQuota: false, theaterIds: ['C0001', 'C0002'] });
      expect(getSelectionSnapshot).toHaveBeenCalledOnce();
      expect(getSelectionSnapshot).toHaveBeenCalledWith(db, 7, { rememberedCountsAsActive: false });
    });

    it('reads remembered choices as active while billing is disabled', async () => {
      vi.stubEnv('BILLING_PROVIDER', 'disabled');
      paidThrough = true;
      counts(6, 6);

      await expect(service.usage(7)).resolves.toEqual(expect.objectContaining({
        offer: null, activeCount: 6, rememberedCount: 0, selectionQuota: 50, overQuota: false,
      }));
      await service.projection(7);
      expect(getSelectionSnapshot).toHaveBeenLastCalledWith(db, 7, { rememberedCountsAsActive: true });
    });
  });

  describe('list and remove', () => {
    const choices = [
      { id: 'C0001', name: 'UGC Opéra', status: 'active' as const, active: true },
      { id: 'C0002', name: 'MK2', status: 'active' as const, active: false },
    ];

    it('lists stored choices with their active flag through the Selection data boundary', async () => {
      vi.mocked(getSelection).mockResolvedValue(choices);
      vi.mocked(removeSelection).mockResolvedValue(true);

      await expect(service.list(7)).resolves.toEqual(choices);
      await expect(service.remove(7, 'C0002')).resolves.toBe(true);
      expect(getSelection).toHaveBeenCalledWith(db, 7, { rememberedCountsAsActive: false });
      expect(removeSelection).toHaveBeenCalledWith(db, 7, 'C0002');
    });

    it('asks for remembered choices as active while billing is disabled', async () => {
      vi.stubEnv('BILLING_PROVIDER', 'disabled');
      vi.mocked(getSelection).mockResolvedValue(choices);

      await service.list(7);
      expect(getSelection).toHaveBeenCalledWith(db, 7, { rememberedCountsAsActive: true });
    });
  });
});
