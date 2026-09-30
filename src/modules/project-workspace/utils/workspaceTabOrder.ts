/**
 * Where plugin tabs go in the workspace tab bar.
 *
 * A plugin can ask for a place through `tabOrder` in its manifest: the index
 * it wants in the final row — `0` is the first tab, `1` the second (right after
 * Chat), and so on. Built-in tabs fill the places the plugins did not take, in
 * their own order. Plugins without a `tabOrder` stay where they always were —
 * after every built-in tab, behind a separator. Positioned plugins carry no
 * separator: they read as part of the built-in row.
 */

export type PositionedTab<T> = {
  tab: T;
  // Requested index in the row, or `null` for "after the built-in tabs".
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
 * Positioned plugins are taken in order of `tabOrder` (equal values keep scan
 * order) and each is placed at its index, or at the next free place when that
 * index is already taken by an earlier plugin. An index past the end of the row
 * lands after the last built-in tab, still ahead of the separator. So with the
 * built-in row Chat, Files, Shell, Git and plugins at 1, 2, 3 the bar reads
 * Chat, plugin, plugin, plugin, Files, Shell, Git.
 */
export function orderTabs<B, P>(builtIn: B[], plugins: Array<PositionedTab<P>>): OrderedTabs<B, P> {
  const positioned = plugins
    .filter((plugin): plugin is PositionedTab<P> & { tabOrder: number } => plugin.tabOrder !== null)
    .sort((a, b) => a.tabOrder - b.tabOrder);
  const trailing = plugins.filter((plugin) => plugin.tabOrder === null).map((plugin) => plugin.tab);

  const tabs: Array<B | P> = [];
  let nextBuiltIn = 0;
  let nextPositioned = 0;
  while (nextBuiltIn < builtIn.length || nextPositioned < positioned.length) {
    const plugin = positioned[nextPositioned];
    const pluginIsDue = plugin !== undefined && (plugin.tabOrder <= tabs.length || nextBuiltIn >= builtIn.length);
    if (pluginIsDue) {
      tabs.push(plugin.tab);
      nextPositioned += 1;
    } else {
      tabs.push(builtIn[nextBuiltIn]);
      nextBuiltIn += 1;
    }
  }

  const separatorIndex = trailing.length > 0 ? tabs.length : null;
  tabs.push(...trailing);

  return { tabs, separatorIndex };
}
