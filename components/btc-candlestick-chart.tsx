"use client";

import { useEffect, useRef } from "react";
import type { PricePoint } from "@/lib/types";

type BtcCandlestickChartProps = {
  data: ReadonlyArray<PricePoint>;
  height?: number;
  title?: string;
  buyPriceKey?: string;
  sellPriceKey?: string;
  buyColor?: string;
  sellColor?: string;
};

export function BtcCandlestickChart({
  data,
  height = 360,
  title = "BTC/USDT · K线（日线）",
  buyPriceKey = "buy",
  sellPriceKey = "sell",
  buyColor = "#00E5A0",
  sellColor = "#FF4D6A",
}: BtcCandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartRef = useRef<any>(null);

  useEffect(() => {
    if (!containerRef.current || !data.length) return;

    import("lightweight-charts").then((lw) => {
      if (!containerRef.current) return;

      // 销毁旧实例
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }

      const chart = lw.createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height,
        layout: {
          background: { color: "#0A0A0F" },
          textColor: "#9999AA",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: "#1A1A2E", style: 1 },
          horzLines: { color: "#1A1A2E", style: 1 },
        },
        crosshair: {
          mode: lw.CrosshairMode.Normal,
          vertLine: { color: "#555566", width: 1, style: 2, labelBackgroundColor: "#1E1E2E" },
          horzLine: { color: "#555566", width: 1, style: 2, labelBackgroundColor: "#1E1E2E" },
        },
        rightPriceScale: {
          borderColor: "#1E1E2E",
          scaleMargins: { top: 0.08, bottom: 0.08 },
        },
        timeScale: {
          borderColor: "#1E1E2E",
          timeVisible: true,
          secondsVisible: false,
        },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
        handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
      });
      chartRef.current = chart;

      const hasOhlc = data.every(
        d => d.open != null && d.high != null && d.low != null
      );

      // 判断是否含时间戳（4h/1h）
      const isIntraday = data.length > 0 && data[0].date.includes(" ");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toTime = (dateStr: string): any => {
        if (isIntraday) return Math.floor(new Date(dateStr.replace(" ", "T") + "Z").getTime() / 1000);
        return dateStr;
      };

      if (hasOhlc) {
        const candleSeries = chart.addSeries(lw.CandlestickSeries, {
          upColor: "#26d0a2",
          downColor: "#ff4d6a",
          borderUpColor: "#4ae8b8",
          borderDownColor: "#ff7a85",
          wickUpColor: "#4ae8b8",
          wickDownColor: "#ff7a85",
        });

        candleSeries.setData(
          data.map(d => ({
            time: toTime(d.date),
            open: d.open as number,
            high: d.high as number,
            low: d.low as number,
            close: d.close,
          }))
        );

        // 买卖标记（超过 300 个时均匀降采样，避免淹没 K 线）
        const numAt = (row: PricePoint, key: string) => {
          const v = (row as unknown as Record<string, unknown>)[key];
          return typeof v === "number" && Number.isFinite(v) ? v : undefined;
        };
        type MarkerEntry = {
          time: ReturnType<typeof toTime>;
          position: "aboveBar" | "belowBar";
          color: string;
          shape: "arrowUp" | "arrowDown";
          text: string;
          size: number;
        };
        const allBuys: MarkerEntry[] = [];
        const allSells: MarkerEntry[] = [];
        for (const d of data) {
          if (numAt(d, buyPriceKey) != null) {
            allBuys.push({ time: toTime(d.date), position: "belowBar", color: buyColor, shape: "arrowUp", text: "买", size: 1 });
          }
          if (numAt(d, sellPriceKey) != null) {
            allSells.push({ time: toTime(d.date), position: "aboveBar", color: sellColor, shape: "arrowDown", text: "卖", size: 1 });
          }
        }

        const MAX_MARKERS = 300;
        const sampleArr = <T,>(arr: T[], max: number): T[] => {
          if (arr.length <= max) return arr;
          const step = arr.length / max;
          const out: T[] = [arr[0]];
          for (let i = 1; i < max - 1; i++) out.push(arr[Math.round(i * step)]);
          out.push(arr[arr.length - 1]);
          return out;
        };
        const markers = [
          ...sampleArr(allBuys, MAX_MARKERS / 2),
          ...sampleArr(allSells, MAX_MARKERS / 2),
        ];
        markers.sort((a, b) => (a.time < b.time ? -1 : 1));
        lw.createSeriesMarkers(candleSeries, markers);
      } else {
        const lineSeries = chart.addSeries(lw.LineSeries, {
          color: "#7B61FF",
          lineWidth: 2,
        });
        lineSeries.setData(
          data.map(d => ({ time: toTime(d.date), value: d.close }))
        );
      }

      chart.timeScale().fitContent();

      // 响应式
      const ro = new ResizeObserver(() => {
        if (containerRef.current && chartRef.current) {
          chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
        }
      });
      ro.observe(containerRef.current);
      return () => ro.disconnect();
    });

    return () => {
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, height, buyPriceKey, sellPriceKey, buyColor, sellColor]);

  return (
    <div className="w-full rounded-xl overflow-hidden" style={{ background: "#0A0A0F", border: "1px solid #1E1E2E" }}>
      {title && (
        <div className="flex items-center justify-between px-4 py-2.5 border-b" style={{ borderColor: "#1E1E2E" }}>
          <span className="text-white text-sm font-medium">{title}</span>
          <span className="text-xs" style={{ color: "#555566" }}>
            滚轮缩放 · 拖动平移
          </span>
        </div>
      )}
      <div ref={containerRef} style={{ width: "100%", height }} />
    </div>
  );
}
