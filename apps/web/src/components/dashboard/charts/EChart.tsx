import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, CanvasRenderer]);

export type ChartInstance = echarts.ECharts;
type ClickParams = { dataIndex: number; seriesIndex: number; seriesName?: string; name?: string };

/**
 * The one ECharts host on the dashboard. The instance is created once per
 * mount and disposed on unmount; option changes are applied with setOption
 * (no re-init); a ResizeObserver keeps it sized to its container. Handlers are
 * read through a ref, so a new callback never rebinds chart events.
 */
export default function EChart({ option, height, label, onClick, onRowClick, onReady, className }: {
  option: object; height: number | string; label: string;
  onClick?: (p: ClickParams) => void;
  /** Horizontal category charts: a click anywhere on a row (label, track or bar) selects that row. */
  onRowClick?: (index: number) => void;
  /** Runs once after init; may return a cleanup. */
  onReady?: (chart: ChartInstance) => void | (() => void);
  className?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ChartInstance | null>(null);
  const click = useRef(onClick);
  click.current = onClick;
  const rowClick = useRef(onRowClick);
  rowClick.current = onRowClick;
  const ready = useRef(onReady);

  useEffect(() => {
    const node = el.current!;
    const c = echarts.init(node, undefined, { renderer: 'canvas' });
    chart.current = c;
    c.on('click', (p) => click.current?.(p as unknown as ClickParams));
    // Row hit-testing for ranked bars: the whole band of a category is clickable, not just the bar.
    const zr = c.getZr();
    const rowAt = (x: number, y: number) => {
      if (!rowClick.current) return -1;
      const opt = c.getOption() as { yAxis?: Array<{ data?: unknown[] }> };
      const n = opt.yAxis?.[0]?.data?.length ?? 0;
      if (!n || y < 0 || x < 0 || x > node.clientWidth) return -1;
      const i = Math.round(c.convertFromPixel({ yAxisIndex: 0 }, y) as number);
      return i >= 0 && i < n ? i : -1;
    };
    zr.on('click', (e: { offsetX: number; offsetY: number }) => { const i = rowAt(e.offsetX, e.offsetY); if (i >= 0) rowClick.current?.(i); });
    zr.on('mousemove', (e: { offsetX: number; offsetY: number }) => { if (rowClick.current) zr.setCursorStyle(rowAt(e.offsetX, e.offsetY) >= 0 ? 'pointer' : 'default'); });
    const cleanup = ready.current?.(c);
    let frame = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => c.resize()); });
    ro.observe(node);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); if (typeof cleanup === 'function') cleanup(); c.dispose(); chart.current = null; };
  }, []);

  useEffect(() => { chart.current?.setOption(option as echarts.EChartsCoreOption, { notMerge: true, lazyUpdate: true }); }, [option]);

  return <div ref={el} role="img" aria-label={label} className={className} style={{ height, width: '100%' }} />;
}
