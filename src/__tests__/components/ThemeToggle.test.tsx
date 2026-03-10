import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ThemeToggle } from '@/components/ThemeToggle';

const mockSetTheme = jest.fn();

jest.mock('next-themes', () => ({
    useTheme: jest.fn(),
}));

import { useTheme } from 'next-themes';
const mockUseTheme = useTheme as jest.Mock;

// jsdom does not implement requestAnimationFrame; calling the callback
// synchronously lets the mounted state flip during act().
let rafCallback: FrameRequestCallback | null = null;
const originalRaf = global.requestAnimationFrame;
const originalCaf = global.cancelAnimationFrame;

beforeAll(() => {
    global.requestAnimationFrame = (cb: FrameRequestCallback) => {
        rafCallback = cb;
        return 0;
    };
    global.cancelAnimationFrame = () => { rafCallback = null; };
});

afterAll(() => {
    global.requestAnimationFrame = originalRaf;
    global.cancelAnimationFrame = originalCaf;
});

/** Render and flush the rAF so mounted becomes true. */
function renderMounted(theme: string, systemTheme: string) {
    mockUseTheme.mockReturnValue({ theme, setTheme: mockSetTheme, systemTheme });
    let result!: ReturnType<typeof render>;
    act(() => {
        result = render(<ThemeToggle />);
    });
    // Now fire the captured rAF callback inside act to flush setState
    act(() => {
        if (rafCallback) rafCallback(0);
        rafCallback = null;
    });
    return result;
}

describe('ThemeToggle', () => {
    it('renders nothing before requestAnimationFrame fires (not yet mounted)', () => {
        mockUseTheme.mockReturnValue({ theme: 'light', setTheme: mockSetTheme, systemTheme: 'light' });
        const { container } = render(<ThemeToggle />);
        // rAF has not been fired yet — mounted is still false
        expect(container.firstChild).toBeNull();
        // clean up pending rAF
        act(() => { if (rafCallback) rafCallback(0); rafCallback = null; });
    });

    it('renders the toggle button after mount', () => {
        renderMounted('light', 'light');
        expect(screen.getByRole('button', { name: /toggle theme/i })).toBeInTheDocument();
    });

    it('shows dark_mode icon when current theme is light', () => {
        renderMounted('light', 'light');
        expect(screen.getByText('dark_mode')).toBeInTheDocument();
    });

    it('shows light_mode icon when current theme is dark', () => {
        renderMounted('dark', 'dark');
        expect(screen.getByText('light_mode')).toBeInTheDocument();
    });

    it('resolves system theme to light and shows dark_mode icon', () => {
        renderMounted('system', 'light');
        expect(screen.getByText('dark_mode')).toBeInTheDocument();
    });

    it('resolves system theme to dark and shows light_mode icon', () => {
        renderMounted('system', 'dark');
        expect(screen.getByText('light_mode')).toBeInTheDocument();
    });

    it('calls setTheme("dark") when current theme is light and button is clicked', () => {
        renderMounted('light', 'light');
        fireEvent.click(screen.getByRole('button', { name: /toggle theme/i }));
        expect(mockSetTheme).toHaveBeenCalledWith('dark');
    });

    it('calls setTheme("light") when current theme is dark and button is clicked', () => {
        renderMounted('dark', 'dark');
        fireEvent.click(screen.getByRole('button', { name: /toggle theme/i }));
        expect(mockSetTheme).toHaveBeenCalledWith('light');
    });
});
