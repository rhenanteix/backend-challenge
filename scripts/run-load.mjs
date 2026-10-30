
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const walletId = process.env.WALLET_ID;
const playerId = process.env.PLAYER_ID;

if (!walletId || !playerId) {
    console.error('Informe WALLET_ID e PLAYER_ID.');
    process.exit(1);
}

mkdirSync('tests/load/results', { recursive: true });

const result = spawnSync(
    'docker',
    [
        'run',
        '--rm',
        '-v',
        `${resolve('tests/load')}:/scripts`,
        '-e',
        `WALLET_ID=${walletId}`,
        '-e',
        `PLAYER_ID=${playerId}`,
        '-e',
        `VUS=${process.env.VUS || '2'}`,
        '-e',
        `DURATION=${process.env.DURATION || '15s'}`,
        '-e',
        `BASE_URL=${process.env.BASE_URL || 'http://host.docker.internal:3000'}`,
        'grafana/k6:latest',
        'run',
        '--summary-export=/scripts/results/summary.json',
        '/scripts/wagering.load.js',
    ],
    { stdio: 'inherit' },
);

process.exit(result.status ?? 1);
