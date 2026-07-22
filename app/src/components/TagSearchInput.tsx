import { useEffect, useRef, useState } from 'react';
import type { Tag } from '@den/shared';
import { fetchTagAutocomplete } from '../lib/tags';

/** Gallery search input with tag autocomplete (stage 4 of the gallery
 *  rework, BACKBONE §15 2026-07-22). Completes the *last* token of the
 *  booru-style query (`beach -scree|` → suggests `screenshots` for the
 *  `scree` prefix, keeping the `-` negation when applying), backed by the
 *  same `GET /chats/:id/tags?prefix=` endpoint and 150ms debounce the
 *  TagEditor already uses. Last-token-only is deliberate: the caret sits at
 *  the end while typing a query in practice, and mid-string token editing
 *  isn't worth caret-tracking complexity here.
 *
 *  Styled with app surface tokens (light+dark), unlike TagEditor's
 *  fixed-dark dropdown, which is built for MediaViewer's always-black
 *  backdrop. */
export function TagSearchInput({
  chatId,
  value,
  onChange,
  placeholder,
}: {
  chatId: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  const [suggestions, setSuggestions] = useState<Tag[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Last whitespace-separated token, split into negation prefix + tag prefix.
  const lastToken = value.slice(value.lastIndexOf(' ') + 1);
  const negated = lastToken.startsWith('-');
  const tokenPrefix = negated ? lastToken.slice(1) : lastToken;

  useEffect(() => {
    if (!tokenPrefix.trim()) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void fetchTagAutocomplete(chatId, tokenPrefix.trim()).then((res) => {
        if (cancelled) return;
        // An exact match with nothing else to offer is pure noise — the user
        // already typed the whole tag.
        const useful = res.tags.length === 1 && res.tags[0]?.name === tokenPrefix.trim() ? [] : res.tags;
        setSuggestions(useful);
        setHighlight(0);
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [chatId, tokenPrefix]);

  function apply(tag: Tag) {
    const head = value.slice(0, value.lastIndexOf(' ') + 1);
    onChange(`${head}${negated ? '-' : ''}${tag.name} `);
    setSuggestions([]);
    inputRef.current?.focus();
  }

  const showDropdown = open && suggestions.length > 0;

  return (
    <div className="relative">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          setOpen(true);
          onChange(e.target.value);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!showDropdown) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((h) => (h + 1) % suggestions.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const s = suggestions[highlight];
            if (s) apply(s);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        className="w-full rounded-sm border border-border bg-surface-raised px-3 py-1.5 text-sm outline-none focus:border-accent"
      />
      {showDropdown && (
        <div className="absolute left-0 top-full z-10 mt-1 w-full overflow-hidden rounded-sm border border-border bg-surface-raised shadow-lg">
          {suggestions.map((s, i) => (
            <button
              key={s.id}
              // preventDefault keeps the input focused so onBlur can't close
              // the dropdown before this click lands.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => apply(s)}
              className={
                'flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors ' +
                (i === highlight ? 'bg-surface-sunken text-text-primary' : 'text-text-primary hover:bg-surface-sunken')
              }
              style={{ touchAction: 'manipulation' }}
            >
              <span>
                {negated && <span className="text-text-muted">-</span>}
                {s.name}
              </span>
              <span className="text-xs text-text-muted">{s.usageCount}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
