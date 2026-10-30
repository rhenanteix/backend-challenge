import { describe, expect, it } from 'vitest';

const BASE_URL =
  process.env.TEST_API_URL ??
  'http://localhost:3000';

describe('API Integration - Availability', () => {
  it('deve responder a requisições HTTP', async () => {
    const response = await fetch(
      `${BASE_URL}/wallets/00000000-0000-4000-8000-000000000000`,
    );

    // Um 404 é válido: a API respondeu,
    // mas a carteira de teste não existe.
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(500);
  });
});
