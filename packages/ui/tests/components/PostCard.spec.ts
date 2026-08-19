import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import PostCard from '../../src/components/PostCard.vue';
import type { Post } from '@spa/shared';

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: 'post-1',
    generationRunId: 'run-1',
    accountId: 'acc-1',
    threadId: null,
    threadPosition: 0,
    network: 'X',
    content: 'Hello world! This is a test post about product launches.',
    sourceRef: null,
    status: 'DRAFT',
    postUrl: null,
    errorMessage: null,
    retryCount: 0,
    llmMetadata: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    approvedAt: null,
    postedAt: null,
    ...overrides,
  };
}

describe('PostCard component', () => {
  it('renders post content', () => {
    const wrapper = mount(PostCard, { props: { post: makePost() } });
    expect(wrapper.text()).toContain('Hello world!');
  });

  it('shows network icon and status badge', () => {
    const wrapper = mount(PostCard, { props: { post: makePost({ network: 'THREADS', status: 'POSTED' }) } });
    expect(wrapper.text()).toContain('Threads');
    expect(wrapper.text()).toContain('POSTED');
  });

  it('does not show action buttons when showActions is false (default)', () => {
    const wrapper = mount(PostCard, { props: { post: makePost() } });
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('shows Approve/Edit/Reject buttons when showActions=true and status=DRAFT', () => {
    const wrapper = mount(PostCard, { props: { post: makePost(), showActions: true } });
    const buttons = wrapper.findAll('button');
    expect(buttons).toHaveLength(3);
    expect(buttons[0].text()).toBe('Approve');
    expect(buttons[1].text()).toBe('Edit');
    expect(buttons[2].text()).toBe('Reject');
  });

  it('does not show action buttons when showActions=true but status is not DRAFT', () => {
    const wrapper = mount(PostCard, { props: { post: makePost({ status: 'APPROVED' }), showActions: true } });
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('emits approve event with post id', async () => {
    const wrapper = mount(PostCard, { props: { post: makePost(), showActions: true } });
    await wrapper.findAll('button')[0].trigger('click');
    expect(wrapper.emitted('approve')).toBeTruthy();
    expect(wrapper.emitted('approve')![0]).toEqual(['post-1']);
  });

  it('emits reject event with post id', async () => {
    const wrapper = mount(PostCard, { props: { post: makePost(), showActions: true } });
    await wrapper.findAll('button')[2].trigger('click');
    expect(wrapper.emitted('reject')).toBeTruthy();
    expect(wrapper.emitted('reject')![0]).toEqual(['post-1']);
  });

  it('emits edit event with post object', async () => {
    const post = makePost();
    const wrapper = mount(PostCard, { props: { post, showActions: true } });
    await wrapper.findAll('button')[1].trigger('click');
    expect(wrapper.emitted('edit')).toBeTruthy();
    expect(wrapper.emitted('edit')![0]).toEqual([post]);
  });

  it('truncates content when truncate prop is set', () => {
    const longContent = 'A'.repeat(200);
    const wrapper = mount(PostCard, { props: { post: makePost({ content: longContent }), truncate: 50 } });
    expect(wrapper.text()).toContain('…');
    // Content should be shorter than full 200 chars
    expect(wrapper.text().length).toBeLessThan(200);
  });

  it('shows post URL link when available', () => {
    const wrapper = mount(PostCard, { props: { post: makePost({ status: 'POSTED', postUrl: 'https://x.com/test/status/123' }) } });
    const link = wrapper.find('a');
    expect(link.exists()).toBe(true);
    expect(link.attributes('href')).toBe('https://x.com/test/status/123');
  });

  it('shows error message when present', () => {
    const wrapper = mount(PostCard, { props: { post: makePost({ status: 'FAILED', errorMessage: 'Browser timeout' }) } });
    expect(wrapper.text()).toContain('Browser timeout');
  });
});
