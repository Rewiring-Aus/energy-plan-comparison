import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * FLIP animation: after each render, any child with a [data-plan-id] that moved
 * is snapped to its old position then transitioned to the new one — so cards
 * visibly slide as the ranking reshuffles.
 */
export function useFlip<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  const prev = useRef<Map<string, number>>(new Map());

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const nodes = el.querySelectorAll<HTMLElement>('[data-plan-id]');
    const next = new Map<string, number>();

    nodes.forEach((node) => {
      const id = node.dataset.planId!;
      const top = node.offsetTop;
      next.set(id, top);
      const old = prev.current.get(id);
      if (old != null && old !== top) {
        const dy = old - top;
        node.style.transition = 'none';
        node.style.transform = `translateY(${dy}px)`;
        requestAnimationFrame(() => {
          node.style.transition = 'transform 320ms cubic-bezier(0.2, 0.7, 0.3, 1)';
          node.style.transform = '';
        });
      }
    });

    prev.current = next;
  });

  return ref;
}
