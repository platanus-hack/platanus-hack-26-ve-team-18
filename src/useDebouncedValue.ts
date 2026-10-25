import { useEffect, useState } from 'react';

/** Returns `value` trailing-debounced: the result only updates after changes to
 *  `value` pause for `delayMs`. Slider input stays live in the UI while the
 *  expensive consumers (viewer part transforms, materials) settle at most every
 *  `delayMs` during a drag. The initial value is returned immediately. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
