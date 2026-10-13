import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const actionPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const testEnv = process.env.TEST_ENV || 'staging';
const releaseTag = `${testEnv}-v1.0.0`;
const originalReadme = '# Demo\n<!--START_SECTION:activity-->\nOld activity\n<!--END_SECTION:activity-->\n';

const events = [
    {
        type: 'ReleaseEvent', public: true,
        repo: { name: 'example/demo' }, created_at: '2026-10-13T12:00:00Z',
        payload: { action: 'published', release: {
            tag_name: releaseTag, draft: false,
            html_url: `https://github.com/example/demo/releases/tag/${releaseTag}`,
        } },
    },
    {
        type: 'IssuesEvent', public: false,
        repo: { name: 'example/secret-repo' }, created_at: '2026-10-13T12:00:00Z',
        payload: { action: 'opened', issue: { number: 42 }, ref: 'secret-branch' },
    },
    {
        type: 'ForkEvent', public: true,
        repo: { name: 'example/ignored-repo' }, created_at: '2026-10-13T12:00:00Z',
        payload: {},
    },
];

async function runAction({ style = 'MARKDOWN', apiFailure = false } = {}) {
    assert.ok(['staging', 'prod'].includes(testEnv), 'TEST_ENV must be staging or prod');
    const directory = await mkdtemp(join(tmpdir(), 'a5-integration-'));
    const readme = join(directory, 'README.md');
    const requests = [];
    const server = createServer((request, response) => {
        const url = new URL(request.url, 'http://localhost');
        requests.push({ method: request.method, path: url.pathname });
        response.setHeader('Content-Type', 'application/json');
        if (request.method !== 'GET') {
            response.writeHead(405);
            response.end(JSON.stringify({ message: 'Writes are forbidden in this test' }));
        } else if (apiFailure) {
            response.writeHead(401);
            response.end(JSON.stringify({ message: 'Mock API authentication failure' }));
        } else if (url.pathname === '/user/starred') {
            response.end('[]');
        } else if (url.pathname === '/users/tester/events') {
            response.end(JSON.stringify(url.searchParams.get('page') === '1' ? events : []));
        } else {
            response.writeHead(404);
            response.end(JSON.stringify({ message: 'Unexpected mock API route' }));
        }
    });

    try {
        await writeFile(readme, originalReadme);
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const { port } = server.address();
        const env = {
            ...process.env,
            ACT: '', NODE_OPTIONS: '', NO_PROXY: '127.0.0.1,localhost',
            GITHUB_API_URL: `http://127.0.0.1:${port}`,
            GITHUB_REPOSITORY: 'example/demo', GITHUB_REF: 'refs/heads/master',
            INPUT_GITHUB_USERNAME: 'tester', INPUT_GITHUB_TOKEN: 'mock-token-not-a-real-secret',
            INPUT_EVENT_LIMIT: '10', INPUT_OUTPUT_STYLE: style,
            INPUT_IGNORE_EVENTS: '["ForkEvent"]', INPUT_HIDE_DETAILS_ON_PRIVATE_REPOS: 'true',
            INPUT_README_PATH: readme, INPUT_COMMIT_MESSAGE: 'Test only',
            INPUT_EVENT_TEMPLATE: '{action} {subject} {number} in [{repo}]({repo_url}) ({ref})',
            INPUT_EVENT_EMOJI_MAP: '', INPUT_DRY_RUN: 'true',
        };
        let result;
        try {
            const output = await execute(process.execPath, [actionPath], {
                cwd: directory, env, timeout: 15000, maxBuffer: 1024 * 1024,
            });
            result = { code: 0, ...output };
        } catch (error) {
            result = { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
        }
        return { ...result, requests, readme: await readFile(readme, 'utf8') };
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
    }
}

test('Built action integrates API events, filtering and Markdown rendering', async () => {
    const result = await runAction();
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(`1. Published release in [example/demo](https://github.com/example/demo) (${releaseTag})`));
    assert.ok(result.stdout.includes('2. Opened issue in a private repository'));
    assert.doesNotMatch(result.stdout, /secret-repo|secret-branch|#42|ignored-repo/);
    assert.ok(result.requests.some(request => request.path === '/users/tester/events'));
    assert.ok(result.requests.every(request => request.method === 'GET'));
    assert.equal(result.readme, originalReadme, 'Dry run must leave README unchanged');
});

test('Built action integrates template rendering with HTML output', async () => {
    const result = await runAction({ style: 'HTML' });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes('<ol>'));
    assert.ok(result.stdout.includes('<li>Published release in <a href="https://github.com/example/demo">example/demo</a>'));
    assert.ok(result.stdout.includes('</ol>'));
    assert.equal(result.readme, originalReadme);
});

test('Built action propagates API errors as a nonzero exit code', async () => {
    const result = await runAction({ apiFailure: true });
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /Mock API authentication failure/);
    assert.ok(result.requests.length > 0);
    assert.equal(result.readme, originalReadme);
});
