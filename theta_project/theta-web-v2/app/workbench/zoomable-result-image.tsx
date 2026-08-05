'use client';

import { useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import { Hand, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';

const MIN_SCALE = 0.5;
const MAX_SCALE = 5;

interface Point {
  x: number;
  y: number;
}

export function ZoomableResultImage({ src, alt }: { src: string; alt: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; origin: Point; position: Point } | undefined>(undefined);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState<Point>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  const reset = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  const zoomAt = (nextScale: number, anchor: Point = { x: 0, y: 0 }) => {
    const bounded = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
    if (bounded === scale) return;
    const ratio = bounded / scale;
    setPosition((current) => ({
      x: anchor.x - (anchor.x - current.x) * ratio,
      y: anchor.y - (anchor.y - current.y) * ratio,
    }));
    setScale(bounded);
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const bounds = viewportRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const anchor = {
      x: event.clientX - bounds.left - bounds.width / 2,
      y: event.clientY - bounds.top - bounds.height / 2,
    };
    zoomAt(scale * (event.deltaY < 0 ? 1.15 : 0.87), anchor);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      origin: { x: event.clientX, y: event.clientY },
      position,
    };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPosition({
      x: drag.position.x + event.clientX - drag.origin.x,
      y: drag.position.y + event.clientY - drag.origin.y,
    });
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    setDragging(false);
  };

  return (
    <div className="overflow-hidden rounded-md border border-slate-200 bg-slate-100">
      <div className="flex h-11 items-center justify-between border-b border-slate-200 bg-white px-2">
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" title="缩小" disabled={scale <= MIN_SCALE} onClick={() => zoomAt(scale / 1.25)} className="h-8 w-8"><ZoomOut className="h-4 w-4" /></Button>
          <span className="w-14 text-center text-xs font-medium text-slate-600">{Math.round(scale * 100)}%</span>
          <Button type="button" variant="ghost" size="icon" title="放大" disabled={scale >= MAX_SCALE} onClick={() => zoomAt(scale * 1.25)} className="h-8 w-8"><ZoomIn className="h-4 w-4" /></Button>
          <Button type="button" variant="ghost" size="icon" title="恢复初始视图" disabled={scale === 1 && position.x === 0 && position.y === 0} onClick={reset} className="ml-1 h-8 w-8"><RotateCcw className="h-4 w-4" /></Button>
        </div>
        <span className="flex items-center gap-1.5 pr-2 text-[11px] text-slate-500"><Hand className="h-3.5 w-3.5" />拖动查看 · 滚轮缩放</span>
      </div>
      <div
        ref={viewportRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onDoubleClick={() => scale === 1 ? zoomAt(2) : reset()}
        className={`relative h-[70vh] select-none overflow-hidden ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={{ touchAction: 'none' }}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="pointer-events-none absolute left-1/2 top-1/2 max-h-[calc(70vh-24px)] max-w-[calc(100%-24px)] object-contain"
          style={{
            transform: `translate(-50%, -50%) translate(${position.x}px, ${position.y}px) scale(${scale})`,
            transformOrigin: 'center',
          }}
        />
      </div>
    </div>
  );
}
