import {useCallback, useRef, useState, type FC} from 'react'
import {Box, type Key, useInput} from 'ink'
import {type IndicatorProps, type ItemProps} from 'ink-select-input'

export type ScrollableListItem<V> = {key?: string; label: string; value: V}
type ItemWithSelection<V> = ItemProps & {value: V}

/**
 * Linear-scroll window derivation (replaces ink-select-input's circular
 * arrayToRotated rotation, which wraps the first item back to the top).
 * Given the previous scroll offset it shifts only as far as needed to keep the
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
 * Controlled, linear-scroll sibling of ink-select-input's SelectInput. The
 * caller owns the ABSOLUTE selected index (`selectedIndex`, a required prop)
 * and reports keys/wheel movement back through `onActiveIndexChange`; the
 * visible window is derived from it (see deriveScrollIndex) instead of
 * rotating the list, so scrolling through long format lists flows like opencode's
 * TUI — the highlight always rides with the selected item.
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
  const prevSelectedRef = useRef(selectedIndex)

  // the derivation is incremental off the previous offset, so it advances here
  // in render whenever the controlled selection moves — React's documented
  // "adjusting state when props change" pattern: the extra render happens
  // before commit, so the viewport never shows the highlight off-screen even
  // for a single frame
  if (prevSelectedRef.current !== selectedIndex) {
    prevSelectedRef.current = selectedIndex
    setScrollIndex(prev => deriveScrollIndex(selectedIndex, limit, items.length, prev))
  }

  // defend against an items list that shrank without the selection moving
  const safeScroll = Math.min(scrollIndex, Math.max(0, items.length - limit))
  const visibleItems = items.slice(safeScroll, safeScroll + limit)

  const handleInput = useCallback(
    (input: string, key: Key) => {
      if (items.length === 0) return
      if (input === 'k' || key.upArrow) {
        const next = Math.max(0, selectedIndex - 1)
        if (next !== selectedIndex) onActiveIndexChange?.(next)
        return
      }
      if (input === 'j' || key.downArrow) {
        const next = Math.min(selectedIndex + 1, items.length - 1)
        if (next !== selectedIndex) onActiveIndexChange?.(next)
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
        onSelect?.(items[selectedIndex])
      }
    },
    [items, onActiveIndexChange, onSelect, safeScroll, selectedIndex],
  )

  useInput(handleInput, {isActive: isFocused})

  const Indicator = indicatorComponent
  const Item = itemComponent
  return (
    <Box flexDirection="column">
      {visibleItems.map((item, index) => {
        const isSelected = safeScroll + index === selectedIndex
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