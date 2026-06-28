import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import StatCard from '../../src/components/StatCard.vue';

describe('StatCard component', () => {
  it('renders label and numeric value', () => {
    const wrapper = mount(StatCard, { props: { label: 'Drafts', value: 42 } });
    expect(wrapper.text()).toContain('Drafts');
    expect(wrapper.text()).toContain('42');
  });

  it('renders string value', () => {
    const wrapper = mount(StatCard, { props: { label: 'Status', value: 'OK' } });
    expect(wrapper.text()).toContain('OK');
  });

  it('applies default text color when no color prop', () => {
    const wrapper = mount(StatCard, { props: { label: 'X', value: 1 } });
    const valueEl = wrapper.find('.text-3xl');
    expect(valueEl.classes()).toContain('text-text-primary');
  });

  it('applies custom color class', () => {
    const wrapper = mount(StatCard, { props: { label: 'Errors', value: 3, color: 'text-error' } });
    const valueEl = wrapper.find('.text-3xl');
    expect(valueEl.classes()).toContain('text-error');
  });
});
