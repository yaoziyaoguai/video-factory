import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

Object.defineProperty(window, "scrollTo", { value: () => undefined, writable: true });
Object.defineProperty(Element.prototype, "scrollIntoView", { value: () => undefined, writable: true, configurable: true });

// DECISION-05 视口契约基线：桌面宽屏 1440×900 为默认档；窄窗/矮窗用例显式改写
// innerWidth/innerHeight，afterEach 统一复位，消除跨用例档位泄漏。
function resetViewport() {
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: 900, configurable: true, writable: true });
}
resetViewport();

// jsdom 的零尺寸会让分隔条命中 user-event 的默认 (0, 0)，抢走普通输入的焦点。
const getBoundingClientRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function () {
  return this.hasAttribute("data-separator")
    ? new DOMRect(680, 100, 20, 400)
    : getBoundingClientRect.call(this);
};

// jsdom 不计算布局；这里提供组件所需的浏览器接口，尺寸与拖动另由真实浏览器验证。
Object.defineProperty(window, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string): MediaQueryList => {
    const min = query.match(/min-width:\s*(\d+)px/);
    const max = query.match(/max-width:\s*(\d+)px/);
    const minH = query.match(/min-height:\s*(\d+)px/);
    const maxH = query.match(/max-height:\s*(\d+)px/);
    const events = new EventTarget();
    return {
      media: query,
      matches: Boolean(min || max || minH || maxH)
        && (!min || window.innerWidth >= Number(min[1])) && (!max || window.innerWidth <= Number(max[1]))
        && (!minH || window.innerHeight >= Number(minH[1])) && (!maxH || window.innerHeight <= Number(maxH[1])),
      onchange: null,
      addListener: (callback) => { if (callback) events.addEventListener("change", callback as EventListener); },
      removeListener: (callback) => { if (callback) events.removeEventListener("change", callback as EventListener); },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    };
  },
});

afterEach(() => {
  cleanup();
  resetViewport();
});
