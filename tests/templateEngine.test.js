import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyTemplate,
    extractEventData,
    getEventAction,
} from '../src/utils/templateEngine.js';

function makeEvent(type, payload = {}, isPublic = true) {
    return {
        type,
        public: isPublic,
        repo: { name: 'example/activity-log' },
        created_at: '2026-10-06T23:30:00Z',
        payload,
    };
}

test('Missing or invalid templates return null', () => {
    for (const template of ['', null, undefined, 123]) {
        assert.equal(applyTemplate(template, {}), null);
    }
});

test('Repeated placeholders are all replaced', () => {
    assert.equal(
        applyTemplate('{repo} / {repo}', { repo: 'example/demo' }),
        'example/demo / example/demo',
    );
});

test('Dollar signs in replacement values remain literal', () => {
    assert.equal(
        applyTemplate('{repo}', { repo: 'cost-$&-$1-$$' }),
        'cost-$&-$1-$$',
    );
});

test('Missing URLs produce readable text rather than empty links', () => {
    assert.equal(
        applyTemplate('[{repo}]({repo_url})', { repo: 'a private repository' }),
        'a private repository',
    );
});

test('Missing optional refs remove empty parentheses', () => {
    assert.equal(
        applyTemplate('{action} ({ref}) in {repo}', {
            action: 'Created', repo: 'example/demo',
        }),
        'Created in example/demo',
    );
});

test('Unrelated literal spacing is preserved', () => {
    assert.equal(
        applyTemplate('Label:  {repo}', { repo: 'example/demo' }),
        'Label:  example/demo',
    );
});

test('Merged PRs are distinguished from closed unmerged PRs', () => {
    assert.equal(getEventAction('PullRequestEvent', {
        action: 'closed', pull_request: { merged: true },
    }), 'merged');
    assert.equal(getEventAction('PullRequestEvent', {
        action: 'closed', pull_request: { merged: false },
    }), 'closed');
});

test('Push events without an action use the commit action', () => {
    assert.equal(getEventAction('PushEvent', {}), 'committed');
});

test('Public push events link to the commit and normalize branch refs', () => {
    const data = extractEventData(makeEvent('PushEvent', {
        head: 'abc123', ref: 'refs/heads/feature/demo',
    }), {});
    assert.equal(data.url, 'https://github.com/example/activity-log/commit/abc123');
    assert.equal(data.ref, 'feature/demo');
});

test('Private events hide repository names, links, issue numbers and refs', () => {
    const event = makeEvent('IssuesEvent', {
        action: 'opened', issue: { number: 42 }, ref: 'secret-branch',
    }, false);
    const data = extractEventData(event, {}, true);
    assert.equal(data.repo, 'a private repository');
    for (const key of ['repo_url', 'url', 'number', 'ref']) {
        assert.equal(data[key], '', `${key} should be hidden`);
    }
    const output = applyTemplate(
        '{action} {subject} {number} in [{repo}]({repo_url}) ({ref})', data,
    );
    assert.doesNotMatch(output, /example\/activity-log|secret-branch|#42|https:\/\//);
});

test('Dates use UTC even near a local date boundary', () => {
    const data = extractEventData(makeEvent('PushEvent'), {});
    assert.equal(data.date, 'Oct 6, 2026');
});

test('Release events use their published release URL and tag', () => {
    const event = makeEvent('ReleaseEvent', {
        action: 'published',
        release: {
            tag_name: 'v1.2.3',
            html_url: 'https://github.com/example/activity-log/releases/tag/v1.2.3',
            draft: false,
        },
    });
    const data = extractEventData(event, {});
    assert.equal(data.ref, 'v1.2.3');
    assert.equal(data.url, event.payload.release.html_url);
});
