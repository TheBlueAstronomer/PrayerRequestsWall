import React from 'react';
import { render, screen } from '@testing-library/react';
import { PrayerCard } from '@/components/PrayerCard';

jest.mock('framer-motion', () => ({
    motion: {
        div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) => (
            <div {...props}>{children}</div>
        ),
    },
}));

const BASE_REQUEST = {
    id: 1,
    content: 'Lord, please heal my mother.',
    createdAt: new Date().toISOString(),
};

describe('PrayerCard', () => {
    it('renders the prayer content', () => {
        render(<PrayerCard request={BASE_REQUEST} index={0} />);
        expect(screen.getByText('Lord, please heal my mother.')).toBeInTheDocument();
    });

    it('shows "Just now" and "New" badge for a request created seconds ago', () => {
        const recent = { ...BASE_REQUEST, createdAt: new Date(Date.now() - 5000).toISOString() };
        render(<PrayerCard request={recent} index={0} />);

        expect(screen.getByText('Just now')).toBeInTheDocument();
        expect(screen.getByText('New')).toBeInTheDocument();
    });

    it('shows "X minute(s) ago" and "New" badge for a request < 1 hour old', () => {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const request = { ...BASE_REQUEST, createdAt: fiveMinutesAgo };
        render(<PrayerCard request={request} index={0} />);

        expect(screen.getByText('5 minutes ago')).toBeInTheDocument();
        expect(screen.getByText('New')).toBeInTheDocument();
    });

    it('shows singular "minute" when diff is exactly 1 minute', () => {
        const oneMinuteAgo = new Date(Date.now() - 61 * 1000).toISOString();
        const request = { ...BASE_REQUEST, createdAt: oneMinuteAgo };
        render(<PrayerCard request={request} index={0} />);

        expect(screen.getByText('1 minute ago')).toBeInTheDocument();
    });

    it('shows "X hour(s) ago" for a request between 1 hour and 24 hours old', () => {
        const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
        const request = { ...BASE_REQUEST, createdAt: twoHoursAgo };
        render(<PrayerCard request={request} index={0} />);

        expect(screen.getByText('2 hours ago')).toBeInTheDocument();
        expect(screen.queryByText('New')).not.toBeInTheDocument();
    });

    it('shows singular "hour" when diff is exactly 1 hour', () => {
        const oneHourAgo = new Date(Date.now() - 3601 * 1000).toISOString();
        const request = { ...BASE_REQUEST, createdAt: oneHourAgo };
        render(<PrayerCard request={request} index={0} />);

        expect(screen.getByText('1 hour ago')).toBeInTheDocument();
    });

    it('shows "Yesterday" for a request exactly 1 day old', () => {
        const yesterday = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
        const request = { ...BASE_REQUEST, createdAt: yesterday };
        render(<PrayerCard request={request} index={0} />);

        expect(screen.getByText('Yesterday')).toBeInTheDocument();
        expect(screen.queryByText('New')).not.toBeInTheDocument();
    });

    it('shows "X days ago" for requests older than 1 day', () => {
        const threeDaysAgo = new Date(Date.now() - 3 * 86400 * 1000).toISOString();
        const request = { ...BASE_REQUEST, createdAt: threeDaysAgo };
        render(<PrayerCard request={request} index={0} />);

        expect(screen.getByText('3 days ago')).toBeInTheDocument();
        expect(screen.queryByText('New')).not.toBeInTheDocument();
    });

    it('accepts a Date object for createdAt', () => {
        const request = { ...BASE_REQUEST, createdAt: new Date(Date.now() - 10000) };
        render(<PrayerCard request={request} index={0} />);
        expect(screen.getByText('Just now')).toBeInTheDocument();
    });

    it('does not show "New" badge for old requests', () => {
        const old = { ...BASE_REQUEST, createdAt: new Date(Date.now() - 2 * 86400 * 1000).toISOString() };
        render(<PrayerCard request={old} index={0} />);
        expect(screen.queryByText('New')).not.toBeInTheDocument();
    });

    it('renders with whitespace preserved (whitespace-pre-wrap)', () => {
        const multiline = { ...BASE_REQUEST, content: 'Line 1\nLine 2' };
        render(<PrayerCard request={multiline} index={0} />);
        expect(screen.getByText((content) => content.includes('Line 1') && content.includes('Line 2'))).toBeInTheDocument();
    });
});
