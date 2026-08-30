import {useRef, useState, type FC} from 'react'
import {Box, type Key, useInput} from 'ink'

// Locally-owned prop types, formerly imported from the now-removed external
// select-input dependency. They are trivially threadbare (isSelected/label
// only), so inlining them removes the dependency with no behaviour change —
// the shapes are guaranteed to match the old imports.
export type IndicatorProps = {isSelected?: boolean}
export type ItemProps = {isSelected?: boolean; label: string}

export type ScrollableListItem<V> = {key?: string; label: string; value: V}
type ItemWithSelection<V> = ItemProps & {value: V}

/**
 * Linear-scroll window derivation (replaces the circular arrayToRotated
 * rotation, which wraps the first item back to the top). Given the previous
 * scroll offset it shifts only as far as needed to keep the
 * selection inside the window, so scrolling is sticky to the highlight:
 * - selection ahead of the window bottom edge → advance one slot past it
 * - selection behind the window top → snap the window back to the selection
 * - otherwise the window does not move at all
 * Clamped to a real scroll range. Pure so it is unit-testable.
 */
export function deriveScrollIndex(
  selectedIndex: number,
  limit: number,
  itemCount: number,
  prevScrollIndex: number,
): number {
  if (itemCount <= limit) return 0
  let next = prevScrollIndex
  if (selectedIndex < next) next = selectedIndex
  else if (selectedIndex >= next + limit) next = selectedIndex - limit + 1
  return Math.max(0, Math.min(next, itemCount - limit))
}

/**
 * Controlled, linear-scroll SelectInput sibling. The caller owns the ABSOLUTE
 * selected index (`selectedIndex`, a required prop) and reports keys/wheel
 * movement back through `onActiveIndexChange`; the visible window is derived
 * from it (see deriveScrollIndex) instead of rotating the list, so scrolling
 * through long format lists flows like opencode's TUI — the highlight always
 * rides with the selected item.
 */
export function ScrollableList<V>({
  items,
  limit,
  selectedIndex,
  onActiveIndexChange,
  onSelect,
  indicatorComponent,
  itemComponent,
  isFocused = true,
}: {
  items: Array<ScrollableListItem<V>>
  limit: number
  selectedIndex: number
  onActiveIndexChange?: (index: number) => void
  onSelect?: (item: ScrollableListItem<V>) => void
  indicatorComponent: FC<IndicatorProps>
  itemComponent: FC<ItemWithSelection<V>>
  isFocused?: boolean
}) {
  const [scrollIndex, setScrollIndex] = useState(() =>
    deriveScrollIndex(selectedIndex, limit, items.length, 0),
  )
  // the selection is clamped to the (possibly shrunk) list before ANY use, so
  // an out-of-range controlled index can never index past the end of items
  const sel = items.length ? Math.min(selectedIndex, items.length - 1) : 0
  const prevSelRef = useRef(sel)
  const prevCountRef = useRef(items.length)

  // the derivation is incremental off the previous offset, so it re-runs here
  // in render whenever the controlled selection moves OR the item count
  // changes — tracking the count (not just the selection) covers the shrink
  // case, where a shorter list with a stationary selection would otherwise
  // keep a stale window hiding the highlight. React's documented "adjusting
  // state when props change" pattern: the extra render happens before commit,
  // so the committed frame always shows the highlight inside the window.
  if (prevSelRef.current !== sel || prevCountRef.current !== items.length) {
    prevSelRef.current = sel
    prevCountRef.current = items.length
    setScrollIndex(prev => deriveScrollIndex(sel, limit, items.length, prev))
  }

  // belt-and-suspenders: scrollIndex may briefly lag the re-derivation for a
  // frame, so clamp the rendered offset to a real range regardless
  const safeScroll = Math.min(scrollIndex, Math.max(0, items.length - limit))
  const visibleItems = items.slice(safeScroll, safeScroll + limit)

  // ink reads this handler through useEffectEvent, so handler identity churn
  // is free — no useCallback needed
  const handleInput = (input: string, key: Key) => {
    if (items.length === 0) return
    if (input === 'k' || key.upArrow) {
      const next = Math.max(0, sel - 1)
      if (next !== sel) onActiveIndexChange?.(next)
      return
    }
    if (input === 'j' || key.downArrow) {
      const next = Math.min(sel + 1, items.length - 1)
      if (next !== sel) onActiveIndexChange?.(next)
      return
    }
    // number keys pick the item at that position in the VISIBLE window,
    // mapped back through the scroll offset to the absolute index — the same
    // contract as SelectInput, but against the linear window, not the rotation
    if (/^[1-9]$/.test(input)) {
      const item = items[safeScroll + Number.parseInt(input, 10) - 1]
      if (item) onSelect?.(item)
      return
    }
    if (key.return) {
      const item = items[sel]
      if (item) onSelect?.(item)
    }
  }

  useInput(handleInput, {isActive: isFocused})

  const Indicator = indicatorComponent
  const Item = itemComponent
  return (
    <Box flexDirection="column">
      {visibleItems.map((item, index) => {
        const isSelected = safeScroll + index === sel
        return (
          <Box key={item.key ?? String(item.value)}>
            <Indicator isSelected={isSelected} />
            <Item {...item} isSelected={isSelected} />
          </Box>
        )
      })}
    </Box>
  )
}