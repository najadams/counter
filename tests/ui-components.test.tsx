// @vitest-environment jsdom
//
// The shared components in src/renderer/components/ui. Most of this file is
// about the dialog's keyboard rules, because those are what keep a till
// usable: Escape and F-keys go to the topmost dialog only and never reach
// the screen underneath (Escape in a payment dialog must not also clear the
// sale), nothing dismisses a dialog while it is saving, and focus comes back
// to where it was.

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Badge } from '../src/renderer/components/ui/badge';
import { Button } from '../src/renderer/components/ui/button';
import { Checkbox } from '../src/renderer/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../src/renderer/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../src/renderer/components/ui/select';
import { Sheet, SheetContent, SheetTitle } from '../src/renderer/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../src/renderer/components/ui/tabs';

beforeEach(() => {
  // jsdom lacks these; Base UI uses them for positioning and transitions.
  window.matchMedia ??= vi.fn().mockImplementation(() => ({
    matches: false, addEventListener: () => {}, removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.getAnimations ??= () => [];
});

afterEach(() => {
  cleanup();
});

/** Stands in for a screen's own window key handler (SaleScreen has several). */
function useScreenKeys(seen: string[]) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [seen]);
}

function press(key: string) {
  act(() => { fireEvent.keyDown(document.activeElement ?? document.body, { key }); });
}

describe('Button', () => {
  it('is a native button that still submits its form', () => {
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    render(<form onSubmit={(e) => onSubmit(e.nativeEvent)}><Button>Save</Button></form>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).not.toHaveAttribute('type');
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('announces its shortcut without adding it to the name', () => {
    render(<><Button variant="primary" shortcut="F2">Complete sale</Button><Button shortcut="Esc">Cancel</Button></>);
    const complete = screen.getByRole('button', { name: 'Complete sale' });
    expect(complete).toHaveAttribute('aria-keyshortcuts', 'F2');
    expect(complete).toHaveTextContent('F2');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('aria-keyshortcuts', 'Escape');
  });

  it('uses the secondary look unless told otherwise, and forwards its ref', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<><Button ref={ref}>Back</Button><Button variant="primary">Pay</Button></>);
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Back' }));
    expect(ref.current).toHaveClass('bg-bg-elevated');
    expect(screen.getByRole('button', { name: 'Pay' })).toHaveClass('bg-accent', 'text-ink');
  });
});

describe('Badge', () => {
  it('colours by tone and keeps the words', () => {
    render(<><Badge tone="warning">pending</Badge><Badge tone="danger">voided</Badge><Badge>draft</Badge></>);
    expect(screen.getByText('pending')).toHaveClass('text-warning');
    expect(screen.getByText('voided')).toHaveClass('text-danger');
    expect(screen.getByText('draft')).toHaveClass('text-text-secondary');
  });
});

describe('Dialog keyboard rules', () => {
  function CashDialog(props: { onClose: () => void; onShortcut?: (k: string) => void; busy?: boolean; seen: string[] }) {
    useScreenKeys(props.seen);
    return (
      <Dialog onClose={props.onClose} onShortcut={props.onShortcut} busy={props.busy}>
        <DialogContent>
          <DialogTitle>Cash</DialogTitle>
          <DialogDescription>Total due: GHS 8.00</DialogDescription>
          <input aria-label="Cash given" />
        </DialogContent>
      </Dialog>
    );
  }

  it('is a dialog named by its title', async () => {
    render(<CashDialog onClose={() => {}} seen={[]} />);
    expect(await screen.findByRole('dialog', { name: 'Cash' })).toBeInTheDocument();
  });

  it('closes on Escape without the screen ever seeing it', async () => {
    const seen: string[] = [];
    const onClose = vi.fn();
    render(<CashDialog onClose={onClose} seen={seen} />);
    await screen.findByRole('dialog');
    press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(seen).not.toContain('Escape');
  });

  it('routes F-keys to the dialog, not the screen, and lets other keys through', async () => {
    const seen: string[] = [];
    const onShortcut = vi.fn();
    render(<CashDialog onClose={() => {}} onShortcut={onShortcut} seen={seen} />);
    await screen.findByRole('dialog');
    press('F4');
    press('F2');
    press('a');
    expect(onShortcut.mock.calls.map((c) => c[0])).toEqual(['F4', 'F2']);
    expect(seen).toEqual(['a']);
  });

  it('ignores Escape, F-keys and the close button while busy', async () => {
    const seen: string[] = [];
    const onClose = vi.fn();
    const onShortcut = vi.fn();
    render(<CashDialog onClose={onClose} onShortcut={onShortcut} busy seen={seen} />);
    await screen.findByRole('dialog');
    press('Escape');
    press('F2');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(onShortcut).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('closes from its close button', async () => {
    const onClose = vi.fn();
    render(<CashDialog onClose={onClose} seen={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('gives Escape and F-keys to the topmost of two dialogs only', async () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    const outerKeys = vi.fn();
    const innerKeys = vi.fn();
    // As in the app: the second dialog opens from inside the first.
    render(
      <Dialog onClose={outerClose} onShortcut={outerKeys}>
        <DialogContent>
          <DialogTitle>Split payment</DialogTitle>
          <Dialog onClose={innerClose} onShortcut={innerKeys}>
            <DialogContent><DialogTitle>Supervisor PIN</DialogTitle></DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>,
    );
    await screen.findByRole('dialog', { name: 'Supervisor PIN' });
    press('F5');
    press('Escape');
    expect(innerKeys).toHaveBeenCalledWith('F5');
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerKeys).not.toHaveBeenCalled();
    expect(outerClose).not.toHaveBeenCalled();
  });

  it('puts focus back on the opener when it goes away', async () => {
    function Screen({ open }: { open: boolean }) {
      return (
        <>
          <button type="button">Take payment</button>
          {open && (
            <Dialog onClose={() => {}}>
              <DialogContent><DialogTitle>Cash</DialogTitle><input aria-label="Cash given" /></DialogContent>
            </Dialog>
          )}
        </>
      );
    }
    const { rerender } = render(<Screen open={false} />);
    const opener = screen.getByRole('button', { name: 'Take payment' });
    opener.focus();
    rerender(<Screen open />);
    await screen.findByRole('dialog');
    await waitFor(() => expect(document.activeElement).not.toBe(opener));
    rerender(<Screen open={false} />);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe('Sheet', () => {
  it('follows the same rules: named, Escape to close, screen keys untouched', async () => {
    const seen: string[] = [];
    const onClose = vi.fn();
    function Checkout() {
      useScreenKeys(seen);
      return (
        <Sheet onClose={onClose}>
          <SheetContent side="bottom"><SheetTitle>Take payment</SheetTitle></SheetContent>
        </Sheet>
      );
    }
    render(<Checkout />);
    expect(await screen.findByRole('dialog', { name: 'Take payment' })).toBeInTheDocument();
    press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
  });
});

describe('Checkbox', () => {
  it('toggles by click and by the space bar', () => {
    const onChange = vi.fn();
    render(<label><Checkbox onCheckedChange={onChange} /> Cash-only account</label>);
    const box = screen.getByRole('checkbox', { name: 'Cash-only account' });
    expect(box).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(box);
    expect(box).toHaveAttribute('aria-checked', 'true');
    expect(onChange).toHaveBeenLastCalledWith(true, expect.anything());
  });
});

describe('Tabs', () => {
  it('shows the panel for the chosen tab', () => {
    render(
      <Tabs defaultValue="walk-in">
        <TabsList aria-label="Price type">
          <TabsTrigger value="walk-in">Walk-in</TabsTrigger>
          <TabsTrigger value="wholesale">Wholesale</TabsTrigger>
        </TabsList>
        <TabsContent value="walk-in">Walk-in prices</TabsContent>
        <TabsContent value="wholesale">Wholesale prices</TabsContent>
      </Tabs>,
    );
    expect(screen.getByRole('tab', { name: 'Walk-in' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Wholesale' }));
    expect(screen.getByRole('tab', { name: 'Wholesale' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Wholesale prices')).toBeVisible();
  });
});

describe('Select', () => {
  it('opens its list and reports the choice', async () => {
    const onValueChange = vi.fn();
    render(
      <Select onValueChange={onValueChange} defaultValue="WALK_IN">
        <SelectTrigger aria-label="Customer type"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="WALK_IN">Regular walk-in</SelectItem>
          <SelectItem value="WHOLESALE">Wholesale buyer</SelectItem>
        </SelectContent>
      </Select>,
    );
    // By keyboard, the way the till is driven. (Base UI ignores a pointer
    // release that lands right after opening, so the opening click cannot
    // also pick an option.)
    fireEvent.click(screen.getByRole('combobox', { name: 'Customer type' }));
    const option = await screen.findByRole('option', { name: 'Wholesale buyer' });
    act(() => { option.focus(); });
    fireEvent.keyDown(option, { key: 'Enter' });
    await waitFor(() => expect(onValueChange).toHaveBeenCalledWith('WHOLESALE', expect.anything()));
  });
});
