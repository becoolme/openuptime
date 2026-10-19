/** Which edges of a scrollable list still have rows hidden behind them (a 1px tolerance for fractional scroll positions). */
export function scrollEdges(scrollTop: number, clientHeight: number, scrollHeight: number): { top: boolean; bottom: boolean } {
  return { top: scrollTop > 1, bottom: scrollTop + clientHeight < scrollHeight - 1 };
}
