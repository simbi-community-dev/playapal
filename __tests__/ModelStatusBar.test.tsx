import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ModelStatusBar } from '../src/components/ModelStatusBar';

function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object' && 'children' in value) {
    return text((value as { children?: unknown }).children);
  }
  return '';
}

describe('ModelStatusBar ready diagnostics', () => {
  it('shows a non-blocking replacement failure and keeps replacement reachable', () => {
    const pick = jest.fn();
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ModelStatusBar
          status={{
            state: 'ready',
            modelName: 'old.gguf',
            detail: 'Could not load bad.gguf; kept old.gguf ready: warm failed',
          }}
          onPickModel={pick}
        />,
      );
    });

    expect(text(renderer!.toJSON())).toContain(
      'Could not load bad.gguf; kept old.gguf ready: warm failed',
    );
    const button = renderer!.root.findByProps({
      accessibilityLabel: 'Choose replacement model',
    });
    act(() => button.props.onPress());
    expect(pick).toHaveBeenCalledTimes(1);
  });
});
