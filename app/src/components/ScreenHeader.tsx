import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Shared top-bar pattern (UI-1, docs/UI_REVAMP.md §5): optional back button,
 * title (+ optional subtitle line), optional trailing action slot, and the
 * safe-area-inset-top padding every screen previously hand-rolled. Pure
 * extraction of what `ChatList`/`ChatView`/`FriendsScreen`/`NewGroupScreen`/
 * `ChatGallery` already did inline — no behavior change.
 */
export function ScreenHeader({
  title,
  subtitle,
  onBack,
  trailing,
  size = 'default',
}: {
  title: ReactNode;
  /** Small line under the title — e.g. ChatView's group member count. */
  subtitle?: ReactNode;
  /** Back button is only rendered when this is provided (ChatList has none). */
  onBack?: () => void;
  /** Right-aligned action slot — e.g. ChatList's New group/Friends buttons. */
  trailing?: ReactNode;
  /** 'large' is the app-level Chats-tab title; everything else is 'default'. */
  size?: 'default' | 'large';
}) {
  return (
    <header
      className="flex items-center gap-3 border-b border-border px-4 py-3"
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
    >
      {onBack && (
        <button
          onClick={onBack}
          aria-label="Back"
          className="flex shrink-0 items-center gap-1 text-sm text-indigo-600 dark:text-indigo-400"
          style={{ touchAction: 'manipulation' }}
        >
          <ArrowLeft size={18} />
          Back
        </button>
      )}
      <div className="min-w-0 flex-1">
        <h1
          className={
            size === 'large' ? 'truncate text-2xl font-bold tracking-tight' : 'truncate font-semibold'
          }
        >
          {title}
        </h1>
        {subtitle && <p className="truncate text-xs text-text-muted">{subtitle}</p>}
      </div>
      {trailing && <div className="flex shrink-0 items-center gap-2">{trailing}</div>}
    </header>
  );
}
