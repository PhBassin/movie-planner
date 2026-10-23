import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteMember } from './members';

/** Stub `fetch` with one response; a null body mimics `res.status(204).send()`. */
function mockFetchOnce(status: number, body: unknown = null) {
  const headers = new Headers();
  if (body !== null) headers.set('content-type', 'application/json');
  const fn = vi.fn(async () =>
    new Response(body === null ? null : JSON.stringify(body), { status, headers }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('members API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('deleteMember', () => {
    it('resolves on the real 204 No Content response (no body to inspect)', async () => {
      const fetchMock = mockFetchOnce(204);

      await expect(deleteMember(7)).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/members/7'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('rejects with the server error envelope on failure', async () => {
      mockFetchOnce(404, { success: false, error: 'Member not found' });

      await expect(deleteMember(999)).rejects.toThrow('Member not found');
    });
  });
});
