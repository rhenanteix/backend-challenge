
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'http://host.docker.internal:3000';
const WALLET_ID = __ENV.WALLET_ID;
const PLAYER_ID = __ENV.PLAYER_ID;

if (!WALLET_ID || !PLAYER_ID) {
    throw new Error('Defina WALLET_ID e PLAYER_ID antes de executar.');
}

const unexpectedErrors = new Rate('unexpected_error_rate');
const processed = new Counter('wager_processed');
const rejected = new Counter('wager_rejected');
const transportErrors = new Counter('transport_errors');

export const options = {
    scenarios: {
        baseline: {
            executor: 'constant-vus',
            vus: Number(__ENV.VUS || 2),
            duration: __ENV.DURATION || '15s',
        },
    },
    summaryTrendStats: [
        'avg',
        'min',
        'med',
        'max',
        'p(90)',
        'p(95)',
        'p(99)',
    ],
    thresholds: {
        unexpected_error_rate: ['rate<0.05'],
    },
};

export default function () {
    const id = `${exec.vu.idInTest}-${exec.scenario.iterationInTest}-${Date.now()}`;

    const payload = {
        providerId: 'jungle-load-test',
        externalTransactionId: `load-${id}`,
        playerId: PLAYER_ID,
        walletId: WALLET_ID,
        roundId: `round-${id}`,
        gameId: 'load-test',
        kind: 'BET',
        money: {
            amount: '0.01',
            currency: 'BRL',
        },
    };

    const response = http.post(
        `${BASE_URL}/wagering/transactions`,
        JSON.stringify(payload),
        {
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': `load-${id}`,
            },
            timeout: '30s',
        },
    );

    let body = null;

    try {
        body = response.json();
    } catch {
        // Resposta inválida ou vazia.
    }

    const validResponse =
        response.status >= 200 &&
        response.status < 300 &&
        Boolean(body?.transactionId) &&
        ['PROCESSED', 'REJECTED'].includes(body?.status);

    check(response, {
        'HTTP e contrato válidos': () => validResponse,
    });

    if (response.status === 0) {
        transportErrors.add(1);
    }

    if (body?.status === 'PROCESSED') {
        processed.add(1);
    }

    if (body?.status === 'REJECTED') {
        rejected.add(1);
    }

    unexpectedErrors.add(!validResponse);
}
