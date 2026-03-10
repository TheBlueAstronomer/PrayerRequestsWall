import React from 'react';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
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

afterEach(() => {
    mockSetTheme.mockClear();
    cleanup();
});

afterAll(() => {
    global.requestAnimationFrame = originalRaf;
    global.cancelAnimationFrame = originalCaf;
});

/** Render before rAF fires (mounted === false). */
function renderUnmounted(theme: string, systemTheme: string) {
    mockUseTheme.mockReturnValue({ theme, setTheme: mockSetTheme, systemTheme });
    return render(<ThemeToggle />);
}

/** Render and flush the rAF so mounted becomes true. */
function renderMounted(theme: string, systemTheme: string) {
    mockUseTheme.mockReturnValue({ theme, setTheme: mockSetTheme, systemTheme });
    let result!: ReturnType<typeof render>;
    act(() => {
        result = render(<ThemeToggle />);
    });
    act(() => {
        if (rafCallback) rafCallback(0);
        rafCallback = null;
    });
    return result;
}

describe('ThemeToggle', () => {
    describe('before mount (rAF not yet fired)', () => {
        it('renders a skeleton placeholder div, not the interactive button', () => {
            const { container } = renderUnmounted('light', 'light');
            expect(screen.queryByRole('button', { name: /toggle theme/i })).toBeNull();
            const skeleton = container.firstChild as HTMLElement;
            expect(skeleton).toHaveClass('fixed', 'top-0', 'z-50', 'flex', 'items-center');
            expect(skeleton).toHaveStyle({ height: '64px' });
            expect(skeleton.firstChild).toHaveStyle({ width: '72px', height: '34px' });
            act(() => { if (rafCallback) rafCallback(0); });
        });
    });

    describe('after mount', () => {
        it('renders the toggle button with aria-label', () => {
            renderMounted('light', 'light');
            expect(screen.getByRole('button', { name: /toggle theme/i })).toBeInTheDocument();
        });

        it('does NOT render the stars SVG in light mode', () => {
            renderMounted('light', 'light');
            expect(screen.queryByTestId('stars-svg')).toBeNull();
        });

        it('renders the stars SVG in dark mode', () => {
            renderMounted('dark', 'dark');
            expect(screen.getByTestId('stars-svg')).toBeInTheDocument();
        });

        it('renders star polygons with correct attributes inside the SVG in dark mode', () => {
            renderMounted('dark', 'dark');
            const polygons = screen.getByTestId('stars-svg').querySelectorAll('polygon');
            expect(polygons.length).toBe(7);
            polygons.forEach((poly) => {
                expect(poly).toHaveAttribute('fill', 'white');
                const points = poly.getAttribute('points');
                expect(points).toBeTruthy();
                expect(points!.split(' ').length).toBe(10);
            });
        });

        it('renders the sun gradient in light mode', () => {
            const { container } = renderMounted('light', 'light');
            const knobDivs = container.querySelectorAll('.rounded-full');
            const sunDiv = Array.from(knobDivs).find(el =>
                (el as HTMLElement).style.background?.includes('#ffe066')
            );
            expect(sunDiv).toBeDefined();
        });

        it('renders the moon gradient in dark mode', () => {
            const { container } = renderMounted('dark', 'dark');
            const knobDivs = container.querySelectorAll('.rounded-full');
            const moonDiv = Array.from(knobDivs).find(el =>
                (el as HTMLElement).style.background?.includes('#d8d8d8')
            );
            expect(moonDiv).toBeDefined();
        });

        it('resolves system theme to light — no stars SVG', () => {
            renderMounted('system', 'light');
            expect(screen.queryByTestId('stars-svg')).toBeNull();
        });

        it('resolves system theme to dark — stars SVG present with correct star count', () => {
            renderMounted('system', 'dark');
            const svg = screen.getByTestId('stars-svg');
            expect(svg).toBeInTheDocument();
            expect(svg.querySelectorAll('polygon').length).toBe(7);
        });
    });

    describe('click behaviour', () => {
        it('calls setTheme("dark") when current theme is light', () => {
            renderMounted('light', 'light');
            fireEvent.click(screen.getByRole('button', { name: /toggle theme/i }));
            expect(mockSetTheme).toHaveBeenCalledWith('dark');
        });

        it('calls setTheme("light") when current theme is dark', () => {
            renderMounted('dark', 'dark');
            fireEvent.click(screen.getByRole('button', { name: /toggle theme/i }));
            expect(mockSetTheme).toHaveBeenCalledWith('light');
        });

        it('calls setTheme("light") when system theme resolves to dark', () => {
            renderMounted('system', 'dark');
            fireEvent.click(screen.getByRole('button', { name: /toggle theme/i }));
            expect(mockSetTheme).toHaveBeenCalledWith('light');
        });

        it('calls setTheme("dark") when system theme resolves to light', () => {
            renderMounted('system', 'light');
            fireEvent.click(screen.getByRole('button', { name: /toggle theme/i }));
            expect(mockSetTheme).toHaveBeenCalledWith('dark');
        });
    });
});
