import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ErrorState from '../../src/components/ErrorState.vue';

describe('ErrorState component', () => {
  it('renders default message', () => {
    const wrapper = mount(ErrorState);
    expect(wrapper.text()).toContain('Something went wrong.');
  });

  it('renders custom error message', () => {
    const wrapper = mount(ErrorState, { props: { message: 'API connection failed' } });
    expect(wrapper.text()).toContain('API connection failed');
  });
});
