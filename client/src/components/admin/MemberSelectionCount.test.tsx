import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MemberSelectionCount from './MemberSelectionCount';

describe('MemberSelectionCount', () => {
  it('shows the stored total alone when nothing is remembered', () => {
    render(<MemberSelectionCount member={{ selection_count: 3, remembered_selection_count: 0 }} />);

    expect(screen.getByTestId('member-selection-count')).toHaveTextContent(/^3$/);
  });

  it('calls out the remembered part of the stored total', () => {
    render(<MemberSelectionCount member={{ selection_count: 23, remembered_selection_count: 20 }} />);

    expect(screen.getByTestId('member-selection-count')).toHaveTextContent('23(20 remembered)');
  });
});
