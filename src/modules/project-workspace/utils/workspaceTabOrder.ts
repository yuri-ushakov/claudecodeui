/**
 * Where plugin tabs go in the workspace tab bar.
 *
 * A plugin can ask for a slot through `tabOrder` in its manifest: the number of
 * built-in tabs it goes after — `0` puts it before the first built-in tab, `1`
 * right after it, and so on. Plugins without a slot stay where they always
 * were — after every built-in tab, behind a separator. Positioned plugins
 * carry no separator: they read as part of the built-in row.
 */

export type PositionedTab<T> = {
  tab: T;
  // Requested slot, or `null` for "after the built-in tabs".
  tabOrder: number | null;
};

export type OrderedTabs<B, P> = {
  tabs: Array<B | P>;
  // Index of the first tab that follows the separator, or `null` when there is
  // no unpositioned plugin and so no separator.
  separatorIndex: number | null;
};

/**
 * Builds the tab list from the built-in tabs and the enabled plugins.
 *
 * The slot counts built-in tabs only, so it means the same thing however many
 * plugins are positioned: every plugin with `tabOrder` N sits between the N-th
 * and the (N+1)-th built-in tab, in scan order; a slot past the last built-in
 * tab lands after it, still ahead of the separator.
 */
export function orderTabs<B, P>(builtIn: B[], plugins: Array<PositionedTab<P>>): OrderedTabs<B, P> {
  const positionedAt = (slot: number): P[] => plugins
    .filter((plugin) => plugin.tabOrder !== null && Math.min(plugin.tabOrder, builtIn.length) === slot)
    .map((plugin) => plugin.tab);
  const trailing = plugins.filter((plugin) => plugin.tabOrder === null).map((plugin) => plugin.tab);

  const tabs: Array<B | P> = [];
  builtIn.forEach((tab, index) => {
    tabs.push(...positionedAt(index), tab);
  });
  tabs.push(...positionedAt(builtIn.length));

  const separatorIndex = trailing.length > 0 ? tabs.length : null;
  tabs.push(...trailing);

  return { tabs, separatorIndex };
}
