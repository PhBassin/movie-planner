import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../db/index.js';
import {
  getActiveTheater,
  lockMemberForSelection,
  getSelection,
  getSelectionCount,
  insertSelection,
  isTheaterSelected,
  removeSelection,
} from '../db/selection-queries.js';
import { ForbiddenError, NotFoundError } from '../utils/errors.js';
import { MAX_SELECTION_SIZE, SelectionService } from './selection-service.js';

vi.mock('../db/selection-queries.js', () => ({
  getActiveTheater: vi.fn(),
  lockMemberForSelection: vi.fn(),
  getSelection: vi.fn(),
  getSelectionCount: vi.fn(),
  insertSelection: vi.fn(),
  isTheaterSelected: vi.fn(),
  removeSelection: vi.fn(),
}));

describe('SelectionService', () => {
  const transactionDb = {} as DB;
  const db = {
    transaction: vi.fn(async (callback: (client: DB) => Promise<unknown>) => callback(transactionDb)),
  } as unknown as DB;
  let service: SelectionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SelectionService(db);
    vi.mocked(lockMemberForSelection).mockResolvedValue({ id: 7, role_name: 'member', status: 'active', email_verified_at: null });
    vi.mocked(getActiveTheater).mockResolvedValue({ id: 'C0001', name: 'UGC Opéra', status: 'active' });
    vi.mocked(isTheaterSelected).mockResolvedValue(false);
    vi.mocked(getSelectionCount).mockResolvedValue(0);
  });

  it('adds an active theater inside a member-row transaction', async () => {
    const theater = await service.add(7, 'C0001');

    expect(theater.id).toBe('C0001');
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(lockMemberForSelection).toHaveBeenCalledWith(transactionDb, 7);
    expect(insertSelection).toHaveBeenCalledWith(transactionDb, 7, 'C0001');
  });

  it('does not apply the cap again when the theater is already selected', async () => {
    vi.mocked(isTheaterSelected).mockResolvedValue(true);
    vi.mocked(getSelectionCount).mockResolvedValue(MAX_SELECTION_SIZE);

    await expect(service.add(7, 'C0001')).resolves.toEqual({
      id: 'C0001',
      name: 'UGC Opéra',
      status: 'active',
    });

    expect(insertSelection).not.toHaveBeenCalled();
  });

  it('rejects a new theater with a 409 when the selection contains 50 theaters', async () => {
    vi.mocked(getSelectionCount).mockResolvedValue(MAX_SELECTION_SIZE);

    await expect(service.add(7, 'C0001')).rejects.toEqual(
      expect.objectContaining({
        statusCode: 409,
        message: expect.stringContaining(String(MAX_SELECTION_SIZE)),
      }),
    );
    expect(insertSelection).not.toHaveBeenCalled();
  });

  it('rejects a provisioning or missing theater', async () => {
    vi.mocked(getActiveTheater).mockResolvedValue(undefined);

    await expect(service.add(7, 'C0001')).rejects.toBeInstanceOf(NotFoundError);
    expect(getSelectionCount).not.toHaveBeenCalled();
  });

  it('rejects Staff accounts even when called directly', async () => {
    vi.mocked(lockMemberForSelection).mockResolvedValue({ id: 1, role_name: 'admin', status: 'active', email_verified_at: null });

    await expect(service.add(1, 'C0001')).rejects.toBeInstanceOf(ForbiddenError);
    expect(getActiveTheater).not.toHaveBeenCalled();
  });

  it('lists and removes only through the Selection data boundary', async () => {
    const selection = [{ id: 'C0001', name: 'UGC Opéra', status: 'active' as const }];
    vi.mocked(getSelection).mockResolvedValue(selection);
    vi.mocked(removeSelection).mockResolvedValue(true);

    await expect(service.list(7)).resolves.toEqual(selection);
    await expect(service.remove(7, 'C0001')).resolves.toBe(true);
    expect(getSelection).toHaveBeenCalledWith(db, 7);
    expect(removeSelection).toHaveBeenCalledWith(db, 7, 'C0001');
  });
});
